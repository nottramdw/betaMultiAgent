import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { errorCode, isAborted } from "../platform/errors.js";
import { ExecError } from "./exec-error.js";
import { trackProcess, untrackProcess } from "./process-registry.js";

const TERM_GRACE_MS = 5_000;
const CLOSE_GRACE_MS = 1_000;
const FORCE_FINISH_MS = 7_000;

export interface SpawnRequest {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly systemRoot: string;
  readonly verbatimArguments: boolean;
  readonly input?: Buffer;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly onStdout: (chunk: Buffer) => void;
  readonly onStderr: (chunk: Buffer) => void;
}

export interface SpawnOutcome {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly durationMs: number;
}

function spawnFailure(error: unknown): ExecError {
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  if (code === "E2BIG" || code === "ENAMETOOLONG") {
    return new ExecError("command-too-long", `the operating system rejected the command line: ${message}`);
  }
  return new ExecError("spawn-failed", message);
}

function killTree(child: ChildProcess, request: SpawnRequest): void {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }
  if (process.platform === "win32") {
    const killer = spawn(path.win32.join(request.systemRoot, "System32", "taskkill.exe"), ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.once("error", () => {
      child.kill("SIGKILL");
    });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      return;
    }
  }, TERM_GRACE_MS).unref();
}

export function runSpawn(request: SpawnRequest): Promise<SpawnOutcome> {
  return new Promise<SpawnOutcome>((resolve, reject) => {
    const started = performance.now();
    if (isAborted(request.signal)) {
      resolve({ exitCode: null, signal: "SIGTERM", timedOut: false, aborted: true, durationMs: 0 });
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(request.file, [...request.args], {
        cwd: request.cwd,
        env: request.env,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: request.verbatimArguments,
        stdio: [request.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (error) {
      reject(spawnFailure(error));
      return;
    }

    if (child.pid !== undefined) {
      trackProcess(child.pid);
    }
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    let graceTimer: NodeJS.Timeout | undefined;
    let forceTimer: NodeJS.Timeout | undefined;

    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(graceTimer);
      clearTimeout(forceTimer);
      request.signal?.removeEventListener("abort", onAbort);
      if (child.pid !== undefined) {
        untrackProcess(child.pid);
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      const killed = timedOut || aborted;
      resolve({
        exitCode: killed && exitCode !== 0 ? null : exitCode,
        signal: exitSignal ?? (killed ? "SIGTERM" : null),
        timedOut,
        aborted,
        durationMs: performance.now() - started,
      });
    };

    const terminate = (): void => {
      killTree(child, request);
      forceTimer ??= setTimeout(finish, FORCE_FINISH_MS);
    };

    function onAbort(): void {
      aborted = true;
      terminate();
    }

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, request.timeoutMs);
    request.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      request.onStdout(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      request.onStderr(chunk);
    });
    child.stdin?.on("error", () => undefined);
    if (request.input !== undefined) {
      child.stdin?.end(request.input);
    }

    child.once("error", (error) => {
      if (child.pid === undefined && !settled) {
        settled = true;
        clearTimeout(timeoutTimer);
        clearTimeout(forceTimer);
        request.signal?.removeEventListener("abort", onAbort);
        reject(spawnFailure(error));
      }
    });
    child.once("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      graceTimer = setTimeout(finish, CLOSE_GRACE_MS);
    });
    child.once("close", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      finish();
    });
  });
}
