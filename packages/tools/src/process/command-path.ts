import { constants, promises as fsp } from "node:fs";
import path from "node:path";
import { isInsideOrEqual } from "../platform/containment.js";
import { getEnvValue, type EnvMap } from "./child-env.js";

export const WINDOWS_EXECUTABLE_EXTENSIONS: readonly string[] = [".exe", ".com", ".cmd", ".bat"];
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

export interface PathSearchOptions {
  readonly env: EnvMap;
  readonly platform: NodeJS.Platform;
  readonly blockedRoots: readonly string[];
  readonly caseSensitive: boolean;
}

export function hasAllowedWindowsExtension(file: string): boolean {
  return WINDOWS_EXECUTABLE_EXTENSIONS.includes(path.win32.extname(file).toLowerCase());
}

export function windowsCandidateNames(name: string, pathext: string | undefined): string[] {
  const extensions = (pathext ?? DEFAULT_PATHEXT)
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => WINDOWS_EXECUTABLE_EXTENSIONS.includes(extension));
  const candidates = hasAllowedWindowsExtension(name) ? [name] : [];
  for (const extension of extensions) {
    candidates.push(`${name}${extension}`);
  }
  return candidates;
}

export async function isExecutableFile(file: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) {
      return false;
    }
    if (platform === "win32") {
      return hasAllowedWindowsExtension(file);
    }
    await fsp.access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function usableDirectory(entry: string, platform: NodeJS.Platform): boolean {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (entry.length === 0 || !pathApi.isAbsolute(entry)) {
    return false;
  }
  return platform !== "win32" || /^[A-Za-z]:\\/u.test(entry);
}

async function isBlocked(directory: string, options: PathSearchOptions): Promise<boolean> {
  let real: string;
  try {
    real = await fsp.realpath(directory);
  } catch {
    return true;
  }
  return options.blockedRoots.some(
    (root) => isInsideOrEqual(root, directory, options.caseSensitive) || isInsideOrEqual(root, real, options.caseSensitive),
  );
}

export async function findOnPath(name: string, options: PathSearchOptions): Promise<string | undefined> {
  const rawPath = getEnvValue(options.env, "PATH", options.platform);
  if (rawPath === undefined) {
    return undefined;
  }
  const delimiter = options.platform === "win32" ? ";" : ":";
  const candidates =
    options.platform === "win32"
      ? windowsCandidateNames(name, getEnvValue(options.env, "PATHEXT", options.platform))
      : [name];
  for (const rawEntry of rawPath.split(delimiter)) {
    const entry = options.platform === "win32" ? rawEntry.replace(/^"(.*)"$/u, "$1") : rawEntry;
    if (!usableDirectory(entry, options.platform) || (await isBlocked(entry, options))) {
      continue;
    }
    for (const candidate of candidates) {
      const file = path.join(entry, candidate);
      if (await isExecutableFile(file, options.platform)) {
        return file;
      }
    }
  }
  return undefined;
}
