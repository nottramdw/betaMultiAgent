import { promises as fsp, type Stats } from "node:fs";
import path from "node:path";
import { PathEscapeError, type PathMode, type ResolvedPath } from "@betamultiagent/core";
import { isInsideOrEqual, stripExtendedPrefix } from "../platform/containment.js";
import { errorCode, errorMessage, isMissingError } from "../platform/errors.js";
import { assertLexicallySafe } from "../platform/path-rules.js";

const MAX_LINK_HOPS = 40;

export interface PathResolverOptions {
  readonly root: string;
  readonly caseSensitive: boolean;
  readonly extraReadRoots: readonly string[];
}

async function readLinkTarget(current: string): Promise<string | undefined> {
  try {
    const stat = await fsp.lstat(current);
    if (!stat.isSymbolicLink()) {
      return undefined;
    }
    return await fsp.readlink(current);
  } catch {
    return undefined;
  }
}

async function realpathOfNearestAncestor(candidate: string, requested: string): Promise<string> {
  let current = candidate;
  let hops = 0;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = stripExtendedPrefix(await fsp.realpath(current));
      return tail.length === 0 ? real : path.join(real, ...tail);
    } catch (error) {
      if (!isMissingError(error)) {
        throw new PathEscapeError(requested, `cannot resolve: ${errorCode(error) ?? errorMessage(error)}`);
      }
    }
    const link = await readLinkTarget(current);
    if (link !== undefined) {
      hops += 1;
      if (hops > MAX_LINK_HOPS) {
        throw new PathEscapeError(requested, "too many symbolic links");
      }
      current = path.resolve(path.dirname(current), stripExtendedPrefix(link));
      continue;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new PathEscapeError(requested, "no existing ancestor directory");
    }
    tail.unshift(path.basename(current));
    current = parent;
  }
}

async function assertWritableTarget(real: string, requested: string): Promise<void> {
  let stat: Stats;
  try {
    stat = await fsp.lstat(real);
  } catch (error) {
    if (isMissingError(error)) {
      return;
    }
    throw new PathEscapeError(requested, `cannot inspect write target: ${errorCode(error) ?? errorMessage(error)}`);
  }
  if (stat.isSymbolicLink()) {
    throw new PathEscapeError(requested, "write target is a symbolic link");
  }
  if (stat.isFile() && stat.nlink > 1) {
    throw new PathEscapeError(requested, "write target has multiple hard links");
  }
}

export function createPathResolver(options: PathResolverOptions): (input: string, mode: PathMode) => Promise<ResolvedPath> {
  const { root, caseSensitive, extraReadRoots } = options;
  const inside = (candidate: string, mode: PathMode): boolean =>
    isInsideOrEqual(root, candidate, caseSensitive) ||
    (mode !== "write" && extraReadRoots.some((extra) => isInsideOrEqual(extra, candidate, caseSensitive)));

  return async (input, mode) => {
    const normalized = assertLexicallySafe(input, process.platform);
    const requested = path.resolve(root, normalized);
    if (!inside(requested, mode)) {
      throw new PathEscapeError(input, "resolves outside the workspace root");
    }
    const real = await realpathOfNearestAncestor(requested, input);
    if (!inside(real, mode)) {
      throw new PathEscapeError(input, "real path resolves outside the workspace root");
    }
    if (mode === "write") {
      await assertWritableTarget(real, input);
    }
    return { requested, real };
  };
}
