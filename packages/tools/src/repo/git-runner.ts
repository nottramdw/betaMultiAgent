import { BoundedCapture } from "../process/bounded-capture.js";
import { buildChildEnv, getEnvValue, type EnvMap } from "../process/child-env.js";
import { findOnPath } from "../process/command-path.js";
import { planSpawn } from "../process/command-line.js";
import { runSpawn } from "../process/spawn-runner.js";

const GIT_TIMEOUT_MS = 300_000;
const STDERR_LIMIT_BYTES = 64 * 1024;
const DEFAULT_COLLECT_LIMIT_BYTES = 32 * 1024 * 1024;

export class GitCommandError extends Error {
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(args: readonly string[], exitCode: number | null, stderr: string) {
    const detail = stderr.trim();
    super(`git ${args.slice(0, 3).join(" ")} failed (exit ${exitCode === null ? "none" : String(exitCode)})${detail.length > 0 ? `: ${detail}` : ""}`);
    this.name = "GitCommandError";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export interface GitRunnerOptions {
  readonly repoRoot: string;
  readonly gitDir: string;
  readonly hooksDir: string;
  readonly caseSensitive: boolean;
  readonly baseEnv?: EnvMap;
  readonly envPassthrough?: readonly string[];
}

export interface GitRunOptions {
  readonly input?: Buffer;
  readonly onStdout?: (chunk: Buffer) => boolean;
  readonly collectLimitBytes?: number;
}

export interface GitResult {
  readonly exitCode: number | null;
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly stoppedEarly: boolean;
}

export class GitRunner {
  readonly #options: GitRunnerOptions;
  readonly #prefix: readonly string[];
  #binary: Promise<string> | undefined;

  constructor(options: GitRunnerOptions) {
    this.#options = options;
    this.#prefix = [
      "--no-pager",
      "-c",
      "core.fsmonitor=false",
      "-c",
      `core.hooksPath=${options.hooksDir}`,
      "-c",
      "core.longpaths=true",
      `--git-dir=${options.gitDir}`,
      `--work-tree=${options.repoRoot}`,
    ];
  }

  #env(): Record<string, string> {
    return buildChildEnv({
      baseEnv: this.#options.baseEnv ?? process.env,
      platform: process.platform,
      ...(this.#options.envPassthrough === undefined ? {} : { passthrough: this.#options.envPassthrough }),
      additionalForced: { GIT_OPTIONAL_LOCKS: "0" },
    });
  }

  #resolveBinary(env: Record<string, string>): Promise<string> {
    this.#binary ??= findOnPath("git", {
      env,
      platform: process.platform,
      blockedRoots: [this.#options.repoRoot],
      caseSensitive: this.#options.caseSensitive,
    }).then((found) => {
      if (found === undefined) {
        throw new Error("git was not found on PATH");
      }
      return found;
    });
    return this.#binary;
  }

  async run(args: readonly string[], options: GitRunOptions = {}): Promise<GitResult> {
    const env = this.#env();
    const binary = await this.#resolveBinary(env);
    const systemRoot = getEnvValue(env, "SystemRoot", process.platform) ?? getEnvValue(env, "windir", process.platform) ?? "C:\\Windows";
    const plan = planSpawn(binary, [...this.#prefix, ...args], process.platform, systemRoot);
    const stderr = new BoundedCapture(STDERR_LIMIT_BYTES);
    const collected: Buffer[] = [];
    const collectLimit = options.collectLimitBytes ?? DEFAULT_COLLECT_LIMIT_BYTES;
    const state = { collectedBytes: 0, stoppedEarly: false };
    const controller = new AbortController();
    const stop = (): void => {
      state.stoppedEarly = true;
      controller.abort();
    };
    const outcome = await runSpawn({
      file: plan.file,
      args: plan.args,
      cwd: this.#options.repoRoot,
      env,
      systemRoot,
      verbatimArguments: plan.verbatimArguments,
      timeoutMs: GIT_TIMEOUT_MS,
      signal: controller.signal,
      ...(options.input === undefined ? {} : { input: options.input }),
      onStdout: (chunk) => {
        if (state.stoppedEarly) {
          return;
        }
        if (options.onStdout !== undefined) {
          if (!options.onStdout(chunk)) {
            stop();
          }
          return;
        }
        state.collectedBytes += chunk.length;
        if (state.collectedBytes > collectLimit) {
          stop();
          return;
        }
        collected.push(chunk);
      },
      onStderr: (chunk) => {
        stderr.push(chunk);
      },
    });
    if (state.stoppedEarly && options.onStdout === undefined) {
      throw new Error(`git output exceeded ${String(collectLimit)} bytes`);
    }
    return {
      exitCode: state.stoppedEarly ? 0 : outcome.exitCode,
      stdout: Buffer.concat(collected),
      stderr: stderr.text(),
      stoppedEarly: state.stoppedEarly,
    };
  }

  async checked(args: readonly string[], options: GitRunOptions = {}): Promise<GitResult> {
    const result = await this.run(args, options);
    if (result.exitCode !== 0) {
      throw new GitCommandError(args, result.exitCode, result.stderr);
    }
    return result;
  }
}
