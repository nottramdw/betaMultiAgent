import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { Provider } from "@betamultiagent/core";
import { afterEach } from "vitest";
import type { CliIo, OutputStream } from "../src/cli-io.js";
import { main } from "../src/main.js";

const created: string[] = [];

export function makeTempDir(prefix = "bma-cli-"): string {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

export function registerCleanup(): void {
  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
}

export function writeTree(root: string, files: Readonly<Record<string, string | Buffer>>): void {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, ...relative.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

export class CaptureStream implements OutputStream {
  readonly isTTY: boolean;
  readonly #chunks: string[] = [];

  constructor(isTTY = false) {
    this.isTTY = isTTY;
  }

  write(text: string): void {
    this.#chunks.push(text);
  }

  get text(): string {
    return this.#chunks.join("");
  }

  jsonLines(): Record<string, unknown>[] {
    return this.text
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}

export interface Sandbox {
  readonly home: string;
  readonly bmaHome: string;
  readonly workspace: string;
  readonly env: Record<string, string>;
}

export function gitEnv(home: string): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(ANTHROPIC_|XAI_|BMA_)/u.test(key)) {
      base[key] = value;
    }
  }
  return {
    ...base,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, "xdg"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(home, "gitconfig-global"),
  };
}

export function makeSandbox(): Sandbox {
  const home = makeTempDir("bma-home-");
  const bmaHome = makeTempDir("bma-state-");
  const workspace = makeTempDir("bma-ws-");
  return { home, bmaHome, workspace, env: { ...gitEnv(home), BMA_HOME: bmaHome } };
}

export interface RunOptions {
  readonly env?: Record<string, string>;
  readonly cwd?: string;
  readonly stdin?: string;
  readonly stdinIsTTY?: boolean;
  readonly stderrIsTTY?: boolean;
  readonly now?: Date;
  readonly providers?: Partial<Record<string, Provider>>;
}

export interface RunResult {
  readonly code: number;
  readonly stdout: CaptureStream;
  readonly stderr: CaptureStream;
}

export async function runBma(sandbox: Sandbox, argv: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream(options.stderrIsTTY ?? false);
  const io: CliIo = {
    stdout,
    stderr,
    stdin: Readable.from(options.stdin === undefined ? [] : [options.stdin]),
    stdinIsTTY: options.stdinIsTTY ?? options.stdin === undefined,
    env: { ...sandbox.env, ...options.env },
    cwd: options.cwd ?? sandbox.workspace,
    platform: process.platform,
    homedir: sandbox.home,
    signals: { on: () => undefined, off: () => undefined },
    exit: (code) => {
      throw new Error(`exit ${String(code)}`);
    },
    now: () => options.now ?? new Date(),
  };
  const code = await main(argv, io, options.providers === undefined ? {} : { providers: options.providers });
  return { code, stdout, stderr };
}

export function git(cwd: string, args: readonly string[], env: Record<string, string>): string {
  return execFileSync("git", [...args], { cwd, env, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
}

export function initRepo(root: string, env: Record<string, string>): void {
  git(root, ["init", "-q", "-b", "main"], env);
  git(root, ["config", "user.name", "Test"], env);
  git(root, ["config", "user.email", "test@example.invalid"], env);
  git(root, ["config", "commit.gpgsign", "false"], env);
  git(root, ["config", "core.autocrlf", "false"], env);
}
