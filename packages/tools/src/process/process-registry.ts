import { spawnSync } from "node:child_process";
import path from "node:path";

const KILL_TIMEOUT_MS = 2_000;

const tracked = new Set<number>();

export function trackProcess(pid: number): void {
  tracked.add(pid);
}

export function untrackProcess(pid: number): void {
  tracked.delete(pid);
}

export function trackedProcessIds(): readonly number[] {
  return [...tracked];
}

function systemRoot(): string {
  return process.env["SystemRoot"] ?? process.env["SYSTEMROOT"] ?? "C:\\Windows";
}

function killTreeSync(pid: number): void {
  if (process.platform === "win32") {
    spawnSync(path.win32.join(systemRoot(), "System32", "taskkill.exe"), ["/T", "/F", "/PID", String(pid)], {
      timeout: KILL_TIMEOUT_MS,
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      return;
    }
  }
}

export function killTrackedProcessTreesSync(): readonly number[] {
  const pids = trackedProcessIds();
  for (const pid of pids) {
    killTreeSync(pid);
    tracked.delete(pid);
  }
  return pids;
}
