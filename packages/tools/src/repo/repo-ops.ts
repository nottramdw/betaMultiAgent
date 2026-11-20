import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, promises as fsp, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  ChangesetTooLargeError,
  type CommitResult,
  type DiffResult,
  type DiffStatEntry,
  type IntegrityReport,
  type RepoOps,
  type RepoPreflight,
} from "@betamultiagent/core";
import { defaultCaseSensitivity, detectCaseSensitivity } from "../platform/case-sensitivity.js";
import { isInsideOrEqual } from "../platform/containment.js";
import { errorMessage } from "../platform/errors.js";
import type { EnvMap } from "../process/child-env.js";
import { GitCommandError, GitRunner } from "./git-runner.js";

export const DEFAULT_MAX_CHANGESET_ENTRIES = 50_000;

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const BRANCH_PATTERN = /^bma\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const IDENTITY_FAILURE = /identity|tell me who you are|auto-detect|user\.(?:name|email)|no email was given|empty ident/iu;

export interface RepoOpsOptions {
  readonly repoRoot: string;
  readonly hooksDir: string;
  readonly worktreesDir: string;
  readonly maxEntries?: number;
  readonly baseEnv?: EnvMap;
  readonly envPassthrough?: readonly string[];
}

interface RepoSetup {
  readonly repoRoot: string;
  readonly caseSensitive: boolean;
  readonly git: GitRunner;
  readonly dotGitFileHash: string | undefined;
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function openRepository(options: RepoOpsOptions): RepoSetup {
  const repoRoot = realpathSync.native(path.resolve(options.repoRoot));
  const caseSensitive = detectCaseSensitivity(repoRoot, defaultCaseSensitivity(process.platform));
  const dotGit = path.join(repoRoot, ".git");
  let gitDir: string;
  let dotGitFileHash: string | undefined;
  if (lstatSync(dotGit).isDirectory()) {
    gitDir = realpathSync.native(dotGit);
  } else {
    const content = readFileSync(dotGit);
    const target = /^gitdir:\s*(.+?)\s*$/mu.exec(content.toString("utf8"))?.[1];
    if (target === undefined) {
      throw new Error(`${dotGit} is not a valid gitdir file`);
    }
    gitDir = realpathSync.native(path.resolve(repoRoot, target));
    dotGitFileHash = sha256(content);
  }
  const hooksDir = path.resolve(options.hooksDir);
  mkdirSync(hooksDir, { recursive: true });
  const git = new GitRunner({
    repoRoot,
    gitDir,
    hooksDir: realpathSync.native(hooksDir),
    caseSensitive,
    ...(options.baseEnv === undefined ? {} : { baseEnv: options.baseEnv }),
    ...(options.envPassthrough === undefined ? {} : { envPassthrough: options.envPassthrough }),
  });
  return { repoRoot, caseSensitive, git, dotGitFileHash };
}

function validateRevision(base: string): void {
  if (base.length === 0 || base.startsWith("-") || /[\0\r\n]/u.test(base)) {
    throw new Error(`invalid revision: ${JSON.stringify(base)}`);
  }
}

async function realpathOrResolve(target: string): Promise<string> {
  return fsp.realpath(target).catch(() => path.resolve(target));
}

async function configFingerprint(git: GitRunner): Promise<string> {
  const result = await git.checked(["config", "--list", "--show-origin", "--show-scope", "-z"]);
  return sha256(result.stdout);
}

class GitRepoOps implements RepoOps {
  readonly #options: RepoOpsOptions;
  readonly #maxEntries: number;
  readonly #setup: RepoSetup | undefined;
  readonly #setupError: Error | undefined;
  readonly #baseline: Promise<string> | undefined;
  readonly #worktrees = new Map<string, { readonly path: string; readonly hash: string }>();

  constructor(options: RepoOpsOptions) {
    this.#options = options;
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_CHANGESET_ENTRIES;
    let setup: RepoSetup | undefined;
    let setupError: Error | undefined;
    let baseline: Promise<string> | undefined;
    try {
      setup = openRepository(options);
      baseline = configFingerprint(setup.git);
      baseline.catch(() => undefined);
    } catch (error) {
      setupError = new Error(`not a usable git repository: ${options.repoRoot} (${errorMessage(error)})`, { cause: error });
    }
    this.#setup = setup;
    this.#setupError = setupError;
    this.#baseline = baseline;
  }

  #open(): RepoSetup {
    if (this.#setup === undefined) {
      throw this.#setupError ?? new Error("git repository is not available");
    }
    return this.#setup;
  }

  #key(value: string): string {
    const resolved = path.resolve(value);
    return this.#open().caseSensitive ? resolved : resolved.toLowerCase();
  }

  async #streamEntries(
    args: readonly string[],
    onEntry: (entry: string) => boolean,
    input?: Buffer,
    okExitCodes: readonly number[] = [0],
  ): Promise<void> {
    let pending: Buffer = Buffer.alloc(0);
    const result = await this.#open().git.run(args, {
      ...(input === undefined ? {} : { input }),
      onStdout: (chunk) => {
        pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
        let start = 0;
        for (;;) {
          const end = pending.indexOf(0, start);
          if (end === -1) {
            break;
          }
          const entry = pending.toString("utf8", start, end);
          start = end + 1;
          if (!onEntry(entry)) {
            return false;
          }
        }
        pending = pending.subarray(start);
        return true;
      },
    });
    if (!result.stoppedEarly && (result.exitCode === null || !okExitCodes.includes(result.exitCode))) {
      throw new GitCommandError(args, result.exitCode, result.stderr);
    }
  }

  async #collectEntries(
    args: readonly string[],
    accept: (entry: string) => string | undefined,
    input?: Buffer,
    okExitCodes?: readonly number[],
  ): Promise<string[]> {
    const state = { collected: new Set<string>(), tooLarge: false };
    await this.#streamEntries(
      args,
      (entry) => {
        const kept = accept(entry);
        if (kept !== undefined) {
          state.collected.add(kept);
          if (state.collected.size > this.#maxEntries) {
            state.tooLarge = true;
            return false;
          }
        }
        return true;
      },
      input,
      okExitCodes,
    );
    if (state.tooLarge) {
      throw new ChangesetTooLargeError(this.#maxEntries);
    }
    return [...state.collected].sort();
  }

  async preflight(): Promise<RepoPreflight> {
    const { git, repoRoot } = this.#open();
    const result = await git.checked(["rev-parse", "--absolute-git-dir", "--git-common-dir", "HEAD"]);
    const [gitDir, commonDir, baseCommit] = result.stdout.toString("utf8").split(/\r?\n/u);
    if (gitDir === undefined || commonDir === undefined || baseCommit === undefined || baseCommit.length === 0) {
      throw new Error("unexpected output from git rev-parse");
    }
    return {
      root: repoRoot,
      gitDir: path.resolve(repoRoot, gitDir),
      commonDir: path.resolve(repoRoot, commonDir),
      baseCommit,
      configFingerprint: await configFingerprint(git),
    };
  }

  async addWorktree(runId: string, base: string): Promise<{ readonly path: string; readonly branch: string }> {
    if (!RUN_ID_PATTERN.test(runId)) {
      throw new Error(`invalid run id: ${JSON.stringify(runId)}`);
    }
    validateRevision(base);
    const { git } = this.#open();
    const branch = `bma/${runId}`;
    const worktreesDir = path.resolve(this.#options.worktreesDir);
    await fsp.mkdir(worktreesDir, { recursive: true });
    const target = path.join(await fsp.realpath(worktreesDir), runId);
    await git.checked(["worktree", "add", "-b", branch, target, base]);
    const real = await fsp.realpath(target);
    const hash = sha256(await fsp.readFile(path.join(real, ".git")));
    this.#worktrees.set(this.#key(real), { path: real, hash });
    return { path: real, branch };
  }

  async removeWorktree(worktreePath: string, options: { readonly force: boolean }): Promise<void> {
    const { git, caseSensitive } = this.#open();
    const base = await realpathOrResolve(path.resolve(this.#options.worktreesDir));
    const target = await realpathOrResolve(path.resolve(worktreePath));
    if (!isInsideOrEqual(base, target, caseSensitive) || this.#key(base) === this.#key(target)) {
      throw new Error(`refusing to remove a path outside the worktrees directory: ${worktreePath}`);
    }
    try {
      await git.checked(["worktree", "remove", ...(options.force ? ["--force"] : []), target]);
    } catch (error) {
      const stillExists = await fsp.stat(target).then(
        () => true,
        () => false,
      );
      if (stillExists) {
        throw error;
      }
    }
    await git.checked(["worktree", "prune"]);
    this.#worktrees.delete(this.#key(target));
  }

  async deleteBranch(name: string): Promise<void> {
    if (!BRANCH_PATTERN.test(name)) {
      throw new Error(`refusing to delete branch ${JSON.stringify(name)}; only bma/<id> branches are managed`);
    }
    await this.#open().git.checked(["branch", "-D", name]);
  }

  async stageAll(): Promise<void> {
    await this.#open().git.checked(["add", "--all"]);
  }

  async commit(message: string): Promise<CommitResult> {
    if (message.trim().length === 0) {
      throw new Error("commit message must not be empty");
    }
    const { git } = this.#open();
    const staged = await git.run(["diff", "--cached", "--quiet", "--exit-code"]);
    if (staged.exitCode === 0) {
      return { committed: false, reason: "nothing is staged" };
    }
    if (staged.exitCode !== 1) {
      throw new GitCommandError(["diff", "--cached"], staged.exitCode, staged.stderr);
    }
    const result = await git.run(["-c", "user.useConfigOnly=true", "commit", "--no-verify", "--no-gpg-sign", "-m", message]);
    if (result.exitCode === 0) {
      const head = await git.checked(["rev-parse", "--verify", "HEAD"]);
      return { committed: true, commit: head.stdout.toString("utf8").trim() };
    }
    if (IDENTITY_FAILURE.test(result.stderr)) {
      return { committed: false, reason: `git identity is not configured: ${result.stderr.trim()}` };
    }
    throw new GitCommandError(["commit"], result.exitCode, result.stderr);
  }

  async changedPaths(base: string): Promise<readonly string[]> {
    validateRevision(base);
    const nonEmpty = (entry: string): string | undefined => (entry.length === 0 ? undefined : entry);
    const tracked = await this.#collectEntries(
      ["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", base, "--"],
      nonEmpty,
    );
    const untracked = await this.#collectEntries(["ls-files", "-z", "--others", "--exclude-standard"], nonEmpty);
    const merged = new Set([...tracked, ...untracked]);
    if (merged.size > this.#maxEntries) {
      throw new ChangesetTooLargeError(this.#maxEntries);
    }
    return [...merged].sort();
  }

  async listIgnored(): Promise<readonly string[]> {
    const state = { skipNext: false };
    return this.#collectEntries(["status", "--porcelain=v1", "-z", "--ignored=matching", "--untracked-files=all"], (entry) => {
      if (state.skipNext) {
        state.skipNext = false;
        return undefined;
      }
      if (/^[RC]|^.[RC]/u.test(entry)) {
        state.skipNext = true;
      }
      return entry.startsWith("!! ") ? entry.slice(3) : undefined;
    });
  }

  async diff(base: string, maxBytes: number): Promise<DiffResult> {
    validateRevision(base);
    const chunks: Buffer[] = [];
    const state = { total: 0, truncated: false };
    const result = await this.#open().git.run(["diff", "--no-ext-diff", "--no-textconv", "--no-color", base, "--"], {
      onStdout: (chunk) => {
        const room = maxBytes - state.total;
        if (chunk.length > room) {
          if (room > 0) {
            chunks.push(chunk.subarray(0, room));
          }
          state.total = maxBytes;
          state.truncated = true;
          return false;
        }
        chunks.push(chunk);
        state.total += chunk.length;
        return true;
      },
    });
    if (!state.truncated && result.exitCode !== 0) {
      throw new GitCommandError(["diff"], result.exitCode, result.stderr);
    }
    return { text: Buffer.concat(chunks).toString("utf8"), truncated: state.truncated };
  }

  async diffStat(base: string): Promise<readonly DiffStatEntry[]> {
    validateRevision(base);
    const entries: DiffStatEntry[] = [];
    const state = { tooLarge: false };
    await this.#streamEntries(
      ["diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", "--no-color", base, "--"],
      (entry) => {
        const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/u.exec(entry);
        if (match === null) {
          return true;
        }
        entries.push({
          path: match[3] ?? "",
          added: match[1] === "-" ? null : Number(match[1]),
          removed: match[2] === "-" ? null : Number(match[2]),
        });
        if (entries.length > this.#maxEntries) {
          state.tooLarge = true;
          return false;
        }
        return true;
      },
    );
    if (state.tooLarge) {
      throw new ChangesetTooLargeError(this.#maxEntries);
    }
    return entries;
  }

  async isIgnored(paths: readonly string[]): Promise<readonly string[]> {
    if (paths.length > this.#maxEntries) {
      throw new ChangesetTooLargeError(this.#maxEntries);
    }
    if (paths.length === 0) {
      return [];
    }
    if (paths.some((item) => item.includes("\0"))) {
      throw new Error("paths must not contain NUL characters");
    }
    const input = Buffer.from(`${paths.join("\0")}\0`, "utf8");
    return this.#collectEntries(["check-ignore", "-z", "--stdin"], (entry) => (entry.length === 0 ? undefined : entry), input, [0, 1]);
  }

  async checkIntegrity(): Promise<IntegrityReport> {
    if (this.#setup === undefined || this.#baseline === undefined) {
      return { ok: false, problems: [this.#setupError?.message ?? "git repository is not available"] };
    }
    const problems: string[] = [];
    try {
      const baseline = await this.#baseline;
      const current = await configFingerprint(this.#setup.git);
      if (current !== baseline) {
        problems.push("the effective git configuration changed since the repository was opened");
      }
    } catch (error) {
      problems.push(`cannot verify the git configuration: ${errorMessage(error)}`);
    }
    if (this.#setup.dotGitFileHash !== undefined) {
      await verifyDotGit(this.#setup.repoRoot, this.#setup.dotGitFileHash, problems);
    }
    for (const tracked of this.#worktrees.values()) {
      await verifyDotGit(tracked.path, tracked.hash, problems);
    }
    return { ok: problems.length === 0, problems };
  }
}

async function verifyDotGit(directory: string, expected: string, problems: string[]): Promise<void> {
  const file = path.join(directory, ".git");
  try {
    if (sha256(await fsp.readFile(file)) !== expected) {
      problems.push(`${file} was modified`);
    }
  } catch (error) {
    problems.push(`${file} cannot be read: ${errorMessage(error)}`);
  }
}

export function createRepoOps(options: RepoOpsOptions): RepoOps {
  return new GitRepoOps(options);
}
