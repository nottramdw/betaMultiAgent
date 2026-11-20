import type { Stats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

export type EntryKind = "directory" | "file" | "symlink" | "missing" | "other";

export interface EntryInfo {
  readonly kind: EntryKind;
  readonly size: number;
}

function foldsCase(): boolean {
  return process.platform === "win32" || process.platform === "darwin";
}

function fold(value: string): string {
  const resolved = path.resolve(value);
  return foldsCase() ? resolved.toLowerCase() : resolved;
}

function isMissingError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) {
    return false;
  }
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}

export function compareText(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

export function samePath(a: string, b: string): boolean {
  return fold(a) === fold(b);
}

export function isInside(base: string, target: string): boolean {
  const relative = path.relative(fold(base), fold(target));
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export async function inspectEntry(target: string): Promise<EntryInfo> {
  let stats: Stats;
  try {
    stats = await lstat(target);
  } catch (error) {
    return { kind: isMissingError(error) ? "missing" : "other", size: 0 };
  }
  if (stats.isSymbolicLink()) {
    return { kind: "symlink", size: stats.size };
  }
  if (stats.isDirectory()) {
    return { kind: "directory", size: stats.size };
  }
  return { kind: stats.isFile() ? "file" : "other", size: stats.size };
}

export async function resolveReal(target: string): Promise<string | undefined> {
  try {
    return await realpath(target);
  } catch {
    return undefined;
  }
}

export async function isGenuineLocation(target: string): Promise<boolean> {
  const real = await resolveReal(target);
  return real !== undefined && samePath(real, target);
}

export function splitRelative(value: string): readonly string[] {
  return value.split(/[\\/]+/u).filter((segment) => segment.length > 0 && segment !== ".");
}

export function isSafeRelativePath(value: string): boolean {
  if (value.length === 0 || value.includes("\0")) {
    return false;
  }
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/u.test(value)) {
    return false;
  }
  return !value.split(/[\\/]+/u).includes("..");
}

export function joinRelative(base: string, value: string): string {
  return path.join(base, ...splitRelative(value));
}
