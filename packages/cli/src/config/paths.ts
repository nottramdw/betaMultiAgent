import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { usageError } from "../cli-error.js";

export const APP_DIR = "betaMultiAgent";

export interface BmaDirs {
  readonly state: string;
  readonly config: string;
  readonly bmaHome?: string;
}

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}

export function resolveDirs(env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform, homedir: string): BmaDirs {
  const paths = pathApi(platform);
  const bmaHome = nonEmpty(env["BMA_HOME"]);
  if (bmaHome !== undefined) {
    const home = paths.resolve(bmaHome);
    return { state: paths.join(home, "state"), config: paths.join(home, "config"), bmaHome: home };
  }
  if (platform === "win32") {
    const local = nonEmpty(env["LOCALAPPDATA"]) ?? paths.join(homedir, "AppData", "Local");
    const roaming = nonEmpty(env["APPDATA"]) ?? paths.join(homedir, "AppData", "Roaming");
    return { state: paths.join(local, APP_DIR), config: paths.join(roaming, APP_DIR) };
  }
  if (platform === "darwin") {
    const base = paths.join(homedir, "Library", "Application Support", APP_DIR);
    return { state: paths.join(base, "state"), config: paths.join(base, "config") };
  }
  const stateHome = nonEmpty(env["XDG_STATE_HOME"]) ?? paths.join(homedir, ".local", "state");
  const configHome = nonEmpty(env["XDG_CONFIG_HOME"]) ?? paths.join(homedir, ".config");
  return { state: paths.join(stateHome, APP_DIR), config: paths.join(configHome, APP_DIR) };
}

export function realpathLoose(target: string): string {
  const absolute = path.resolve(target);
  const pending: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return path.join(realpathSync.native(current), ...pending.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return absolute;
      }
      pending.push(path.basename(current));
      current = parent;
    }
  }
}

function foldCase(platform: NodeJS.Platform): (value: string) => string {
  return platform === "win32" || platform === "darwin" ? (value) => value.toLowerCase() : (value) => value;
}

export function isInsideOrEqual(parent: string, child: string, platform: NodeJS.Platform): boolean {
  const fold = foldCase(platform);
  const paths = pathApi(platform);
  const relative = paths.relative(fold(parent), fold(child));
  return relative === "" || (!relative.startsWith("..") && !paths.isAbsolute(relative));
}

export function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const fold = foldCase(platform);
  const paths = pathApi(platform);
  return fold(paths.resolve(a)) === fold(paths.resolve(b));
}

export function resolveWorkspaceRoot(cwd: string, dirs: BmaDirs, homedir: string, platform: NodeJS.Platform): string {
  let root: string;
  try {
    root = realpathSync.native(cwd);
  } catch {
    throw usageError(`the current directory cannot be resolved: ${cwd}`);
  }
  if (samePath(root, realpathLoose(homedir), platform)) {
    throw usageError("refusing to use the home directory as the workspace root; run bma inside a project directory");
  }
  if (path.parse(root).root === root) {
    throw usageError("refusing to use a drive or file system root as the workspace root");
  }
  const protectedDirs = [dirs.state, dirs.config, ...(dirs.bmaHome === undefined ? [] : [dirs.bmaHome])];
  for (const dir of protectedDirs) {
    if (isInsideOrEqual(root, realpathLoose(dir), platform)) {
      throw usageError(`refusing to use ${root} as the workspace root because it contains the bma directory ${dir}`);
    }
  }
  return root;
}

export function projectKey(root: string): string {
  return createHash("sha256").update(root).digest("hex").slice(0, 16);
}

export function projectStateDir(dirs: BmaDirs, root: string): string {
  return path.join(dirs.state, "projects", projectKey(root));
}

export function sessionsDir(dirs: BmaDirs, root: string): string {
  return path.join(projectStateDir(dirs, root), "sessions");
}

export function runsDir(dirs: BmaDirs, root: string): string {
  return path.join(projectStateDir(dirs, root), "runs");
}

export function auditDir(dirs: BmaDirs, root: string): string {
  return path.join(projectStateDir(dirs, root), "audit");
}

export function tasksDir(dirs: BmaDirs, root: string): string {
  return path.join(projectStateDir(dirs, root), "tasks");
}

export function worktreesDir(dirs: BmaDirs): string {
  return path.join(dirs.state, "worktrees");
}

export function userConfigFile(dirs: BmaDirs): string {
  return path.join(dirs.config, "config.json");
}

export function trustFile(dirs: BmaDirs): string {
  return path.join(dirs.state, "trust.json");
}

export const PROJECT_CONFIG_FILE = "bma.config.json";
