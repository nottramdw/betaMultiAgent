import { createHash, randomBytes } from "node:crypto";
import { promises as fsp, type Stats } from "node:fs";
import path from "node:path";
import type { FileState, FileStateStore } from "@betamultiagent/core";
import { errorCode } from "../platform/errors.js";

export const MAX_READ_BYTES = 10 * 1024 * 1024;
export const BINARY_PROBE_BYTES = 8 * 1024;

const RENAME_ATTEMPTS = 6;
const RENAME_BACKOFF_MS = 25;
const RETRYABLE_RENAME_CODES: ReadonlySet<string> = new Set(["EPERM", "EBUSY", "EACCES"]);

export function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function looksBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, BINARY_PROBE_BYTES).includes(0);
}

export interface LoadedFile {
  readonly bytes: Buffer;
  readonly stat: Stats;
}

export async function loadFile(real: string, maxBytes: number = MAX_READ_BYTES): Promise<LoadedFile> {
  const handle = await fsp.open(real, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error(`not a regular file: ${real}`);
    }
    if (stat.size > maxBytes) {
      throw new Error(`file is ${String(stat.size)} bytes; the limit is ${String(maxBytes)} bytes`);
    }
    const bytes = await handle.readFile();
    return { bytes, stat };
  } finally {
    await handle.close();
  }
}

export function recordFileState(store: FileStateStore, real: string, stat: Pick<Stats, "mtimeMs" | "size">, bytes: Buffer): void {
  const state: FileState = { mtimeMs: stat.mtimeMs, size: stat.size, sha256: sha256Hex(bytes) };
  store.set(real, state);
}

export async function assertUnchangedSinceRead(
  store: FileStateStore,
  real: string,
  display: string,
  stat: Pick<Stats, "mtimeMs" | "size">,
  bytes?: Buffer,
): Promise<void> {
  const known = store.get(real);
  if (known === undefined) {
    throw new Error(`${display} already exists but has not been read in this session; read it with read_file before modifying it`);
  }
  if (bytes !== undefined) {
    if (sha256Hex(bytes) === known.sha256) {
      return;
    }
  } else if (known.size === stat.size) {
    if (known.mtimeMs === stat.mtimeMs || sha256Hex(await fsp.readFile(real)) === known.sha256) {
      return;
    }
  }
  throw new Error(`${display} changed since it was read; read it again before modifying it`);
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (error) {
      const code = errorCode(error);
      const retryable = process.platform === "win32" && code !== undefined && RETRYABLE_RENAME_CODES.has(code);
      if (!retryable || attempt >= RENAME_ATTEMPTS) {
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, RENAME_BACKOFF_MS * attempt));
    }
  }
}

export interface AtomicWriteOptions {
  readonly real: string;
  readonly data: Buffer;
  readonly mode?: number;
  readonly beforeRename: () => Promise<void>;
}

export async function atomicWrite(options: AtomicWriteOptions): Promise<void> {
  const directory = path.dirname(options.real);
  await fsp.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.bma-${randomBytes(6).toString("hex")}.tmp`);
  try {
    await fsp.writeFile(temporary, options.data, { flag: "wx" });
    if (options.mode !== undefined && process.platform !== "win32") {
      await fsp.chmod(temporary, options.mode & 0o7777);
    }
    await options.beforeRename();
    await renameWithRetry(temporary, options.real);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
