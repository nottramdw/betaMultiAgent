import { mkdir, open, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

export const LOCK_FILE = "runner.lock";

const LockSchema = z.object({ pid: z.number().int().positive(), hostname: z.string(), startedAt: z.string() });
export type LockOwner = z.infer<typeof LockSchema>;

export interface LockEnvironment {
  readonly pid: number;
  readonly hostname: string;
  readonly now: () => Date;
  readonly isAlive: (pid: number) => boolean;
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function defaultLockEnvironment(now: () => Date): LockEnvironment {
  return { pid: process.pid, hostname: os.hostname(), now, isAlive: processIsAlive };
}

export class RunnerLockError extends Error {}

export interface RunnerLock {
  readonly file: string;
  readonly replaced?: LockOwner;
  release(): Promise<void>;
}

async function readOwner(file: string): Promise<LockOwner | undefined> {
  try {
    const parsed = LockSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function create(file: string, owner: LockOwner): Promise<boolean> {
  try {
    const handle = await open(file, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(owner), "utf8");
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

export interface LockNaming {
  readonly file?: string;
  readonly holder?: string;
}

export async function acquireRunnerLock(dir: string, env: LockEnvironment, naming: LockNaming = {}): Promise<RunnerLock> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, naming.file ?? LOCK_FILE);
  const holder = naming.holder ?? "task runner";
  const owner: LockOwner = { pid: env.pid, hostname: env.hostname, startedAt: env.now().toISOString() };
  const release = async () => {
    const current = await readOwner(file);
    if (current?.pid === owner.pid && current.hostname === owner.hostname && current.startedAt === owner.startedAt) {
      await rm(file, { force: true });
    }
  };
  if (await create(file, owner)) {
    return { file, release };
  }
  const existing = await readOwner(file);
  if (existing === undefined) {
    throw new RunnerLockError(`another ${holder} holds ${file} and its owner cannot be read; remove the file if no ${holder} is active`);
  }
  if (existing.hostname !== env.hostname || env.isAlive(existing.pid)) {
    throw new RunnerLockError(
      `another ${holder} is active (pid ${String(existing.pid)} on ${existing.hostname}, since ${existing.startedAt}); lock file ${file}`,
    );
  }
  await rm(file, { force: true });
  if (!(await create(file, owner))) {
    throw new RunnerLockError(`another ${holder} took ${file} while a stale lock was being replaced`);
  }
  return { file, replaced: existing, release };
}
