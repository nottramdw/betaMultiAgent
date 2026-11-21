import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { InMemoryFileStateStore, type Environment, type ToolContext, type ToolDefinition, type ToolResult } from "@betamultiagent/core";
import { afterEach } from "vitest";

const created: string[] = [];

export function makeTempDir(prefix = "bma-tools-"): string {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

export function registerCleanup(): void {
  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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

export interface ContextOptions {
  readonly signal?: AbortSignal;
  readonly denied?: (target: string, mode: "read" | "write") => boolean;
}

export function makeContext(environment: Environment, options: ContextOptions = {}): ToolContext {
  return {
    environment,
    signal: options.signal ?? new AbortController().signal,
    sessionId: "test-session",
    agentName: "tester",
    fileState: new InMemoryFileStateStore(),
    depth: 0,
    isPathDenied: (target, mode) => Promise.resolve(options.denied?.(target, mode) ?? false),
  };
}

export async function runTool<I, O>(tool: ToolDefinition<I, O>, input: I, context: ToolContext): Promise<ToolResult<O>> {
  return tool.execute(tool.input.parse(input), context);
}

export function isolatedGitEnv(home: string): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
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

export function git(cwd: string, args: readonly string[], env: Record<string, string>): string {
  return execFileSync("git", [...args], { cwd, env, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
}

export function initRepo(root: string, env: Record<string, string>, withIdentity = true): void {
  git(root, ["init", "-q", "-b", "main"], env);
  if (withIdentity) {
    git(root, ["config", "user.name", "Test"], env);
    git(root, ["config", "user.email", "test@example.invalid"], env);
  }
  git(root, ["config", "commit.gpgsign", "false"], env);
}

export function hasCommand(command: string, args: readonly string[] = ["--version"]): boolean {
  try {
    execFileSync(command, [...args], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
