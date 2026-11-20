import { realpathSync, statSync, promises as fsp } from "node:fs";
import path from "node:path";
import { PathEscapeError, type Environment, type ExecOptions, type ExecResult } from "@betamultiagent/core";
import { defaultCaseSensitivity, detectCaseSensitivity } from "../platform/case-sensitivity.js";
import { isInsideOrEqual } from "../platform/containment.js";
import { BoundedCapture } from "../process/bounded-capture.js";
import { buildChildEnv, getEnvValue, type EnvMap } from "../process/child-env.js";
import { findOnPath, hasAllowedWindowsExtension, isExecutableFile, windowsCandidateNames } from "../process/command-path.js";
import { planSpawn } from "../process/command-line.js";
import { ExecError } from "../process/exec-error.js";
import { runSpawn } from "../process/spawn-runner.js";
import { createPathResolver } from "./path-resolver.js";

export const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
export const MAX_EXEC_TIMEOUT_MS = 600_000;

export interface LocalEnvironmentOptions {
  readonly root: string;
  readonly id?: string;
  readonly extraReadRoots?: readonly string[];
  readonly envPassthrough?: readonly string[];
  readonly envDenylist?: readonly string[];
  readonly baseEnv?: EnvMap;
}

function clampTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_EXEC_TIMEOUT_MS;
  }
  return Math.min(Math.max(Math.trunc(value), 1), MAX_EXEC_TIMEOUT_MS);
}

function validateArgv(argv: readonly string[]): string {
  const [program] = argv;
  if (program === undefined || program.length === 0) {
    throw new ExecError("invalid-argv", "argv must contain a non-empty program name");
  }
  if (argv.some((token) => token.includes("\0"))) {
    throw new ExecError("invalid-argv", "argv must not contain NUL characters");
  }
  return program;
}

function resolveExtraRoots(roots: readonly string[]): string[] {
  const resolved: string[] = [];
  for (const candidate of roots) {
    try {
      resolved.push(realpathSync.native(path.resolve(candidate)));
    } catch {
      continue;
    }
  }
  return resolved;
}

function createEnvironment(kind: Environment["kind"], options: LocalEnvironmentOptions): Environment {
  const platform = process.platform;
  let root: string;
  try {
    root = realpathSync.native(path.resolve(options.root));
    if (!statSync(root).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`environment root is not an accessible directory: ${options.root} (${reason})`, { cause: error });
  }
  const caseSensitive = detectCaseSensitivity(root, defaultCaseSensitivity(platform));
  const resolvePath = createPathResolver({
    root,
    caseSensitive,
    extraReadRoots: resolveExtraRoots(options.extraReadRoots ?? []),
  });

  const resolveCwd = async (cwd: string | undefined): Promise<string> => {
    const resolved = await resolvePath(cwd ?? root, "cwd");
    if (!isInsideOrEqual(root, resolved.real, caseSensitive)) {
      throw new PathEscapeError(cwd ?? root, "working directory is outside the workspace root");
    }
    const isDirectory = await fsp.stat(resolved.real).then(
      (stat) => stat.isDirectory(),
      () => false,
    );
    if (!isDirectory) {
      throw new ExecError("invalid-cwd", `working directory is not a directory: ${cwd ?? root}`);
    }
    return resolved.real;
  };

  const locateExecutable = async (program: string, cwd: string, env: Record<string, string>): Promise<string> => {
    if (program.includes("/") || program.includes("\\")) {
      const target = await resolvePath(path.resolve(cwd, program), "read");
      if (!isInsideOrEqual(root, target.real, caseSensitive)) {
        throw new PathEscapeError(program, "executable is outside the workspace root");
      }
      const candidates =
        platform === "win32"
          ? hasAllowedWindowsExtension(target.real)
            ? [target.real]
            : windowsCandidateNames(target.real, getEnvValue(env, "PATHEXT", platform))
          : [target.real];
      for (const candidate of candidates) {
        if (await isExecutableFile(candidate, platform)) {
          return candidate;
        }
      }
      throw new ExecError("command-not-found", `not an executable file: ${program}`);
    }
    const found = await findOnPath(program, { env, platform, blockedRoots: [root], caseSensitive });
    if (found === undefined) {
      throw new ExecError(
        "command-not-found",
        `command not found on PATH: ${program} (PATH entries that are relative or inside the workspace are ignored)`,
      );
    }
    return found;
  };

  const exec = async (argv: readonly string[], execOptions: ExecOptions = {}): Promise<ExecResult> => {
    const program = validateArgv(argv);
    const timeoutMs = clampTimeout(execOptions.timeoutMs);
    const cwd = await resolveCwd(execOptions.cwd);
    const env = buildChildEnv({
      baseEnv: options.baseEnv ?? process.env,
      platform,
      ...(options.envPassthrough === undefined ? {} : { passthrough: options.envPassthrough }),
      ...(options.envDenylist === undefined ? {} : { denylist: options.envDenylist }),
      ...(execOptions.env === undefined ? {} : { extra: execOptions.env }),
    });
    const file = await locateExecutable(program, cwd, env);
    const systemRoot = getEnvValue(env, "SystemRoot", platform) ?? getEnvValue(env, "windir", platform) ?? "C:\\Windows";
    const plan = planSpawn(file, argv.slice(1), platform, systemRoot);
    const stdout = new BoundedCapture();
    const stderr = new BoundedCapture();
    const outcome = await runSpawn({
      file: plan.file,
      args: plan.args,
      cwd,
      env,
      systemRoot,
      verbatimArguments: plan.verbatimArguments,
      timeoutMs,
      ...(execOptions.signal === undefined ? {} : { signal: execOptions.signal }),
      onStdout: (chunk) => {
        stdout.push(chunk);
      },
      onStderr: (chunk) => {
        stderr.push(chunk);
      },
    });
    return {
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stdout: stdout.text(),
      stderr: stderr.text(),
      timedOut: outcome.timedOut,
      truncated: stdout.truncated || stderr.truncated,
      durationMs: Math.round(outcome.durationMs),
    };
  };

  return {
    id: options.id ?? `${kind}:${root}`,
    kind,
    root,
    caseSensitive,
    resolvePath,
    exec,
  };
}

export function createLocalEnvironment(options: LocalEnvironmentOptions): Environment {
  return createEnvironment("local", options);
}

export function createGitWorktreeEnvironment(options: LocalEnvironmentOptions): Environment {
  return createEnvironment("git-worktree", options);
}
