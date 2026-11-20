import { promises as fsp, type Dirent } from "node:fs";
import path from "node:path";
import { isInsideOrEqual } from "../platform/containment.js";
import { isAborted } from "../platform/errors.js";

export const MAX_VISITED_ENTRIES = 200_000;

const SKIPPED_NAMES: ReadonlySet<string> = new Set([".git", "node_modules"]);

export interface WalkedFile {
  readonly absolute: string;
  readonly relative: string;
}

export interface WalkOptions {
  readonly root: string;
  readonly start: string;
  readonly caseSensitive: boolean;
  readonly signal: AbortSignal;
}

export interface WalkSummary {
  readonly limitReached: boolean;
}

function compareNames(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

async function resolveLinkedFile(absolute: string, options: WalkOptions): Promise<boolean> {
  try {
    const real = await fsp.realpath(absolute);
    if (!isInsideOrEqual(options.root, real, options.caseSensitive)) {
      return false;
    }
    return (await fsp.stat(real)).isFile();
  } catch {
    return false;
  }
}

export async function walkFiles(options: WalkOptions, visit: (file: WalkedFile) => Promise<boolean>): Promise<WalkSummary> {
  let visited = 0;
  let stopped = false;
  let limitReached = false;
  const skipped = options.caseSensitive ? SKIPPED_NAMES : new Set([...SKIPPED_NAMES].map((name) => name.toLowerCase()));

  const walkDirectory = async (directory: string, relativeDirectory: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => compareNames(left.name, right.name));
    for (const entry of entries) {
      if (stopped || isAborted(options.signal)) {
        return;
      }
      visited += 1;
      if (visited > MAX_VISITED_ENTRIES) {
        stopped = true;
        limitReached = true;
        return;
      }
      if (skipped.has(options.caseSensitive ? entry.name : entry.name.toLowerCase())) {
        continue;
      }
      const absolute = path.join(directory, entry.name);
      const relative = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) {
        await walkDirectory(absolute, relative);
        continue;
      }
      const isFile = entry.isFile() || (entry.isSymbolicLink() && (await resolveLinkedFile(absolute, options)));
      if (isFile && !(await visit({ absolute, relative }))) {
        stopped = true;
        return;
      }
    }
  };

  await walkDirectory(options.start, "");
  return { limitReached };
}

export function toDisplayPath(root: string, absolute: string): string {
  const relative = path.relative(root, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return absolute.split(path.sep).join("/");
  }
  return relative.split(path.sep).join("/");
}
