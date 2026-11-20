export type PathMode = "read" | "write" | "cwd";

export interface ResolvedPath {
  readonly requested: string;
  readonly real: string;
}

export interface ExecOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly env?: Readonly<Record<string, string>>;
}

export interface ExecResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly durationMs: number;
}

export interface Environment {
  readonly id: string;
  readonly kind: "local" | "git-worktree";
  readonly root: string;
  readonly caseSensitive: boolean;
  resolvePath(path: string, mode: PathMode): Promise<ResolvedPath>;
  exec(argv: readonly string[], options?: ExecOptions): Promise<ExecResult>;
}

export interface EnvironmentFactory {
  create(root: string): Promise<Environment>;
}

export interface FileState {
  readonly mtimeMs: number;
  readonly size: number;
  readonly sha256: string;
}

export interface FileStateStore {
  get(realPath: string): FileState | undefined;
  set(realPath: string, state: FileState): void;
}

export class InMemoryFileStateStore implements FileStateStore {
  readonly #states = new Map<string, FileState>();

  get(realPath: string): FileState | undefined {
    return this.#states.get(realPath);
  }

  set(realPath: string, state: FileState): void {
    this.#states.set(realPath, state);
  }
}

export class PathEscapeError extends Error {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`path is outside the workspace: ${path} (${reason})`);
    this.name = "PathEscapeError";
    this.path = path;
  }
}

export class ChangesetTooLargeError extends Error {
  readonly limit: number;

  constructor(limit: number) {
    super(`changeset exceeds ${String(limit)} entries`);
    this.name = "ChangesetTooLargeError";
    this.limit = limit;
  }
}

export interface RepoPreflight {
  readonly root: string;
  readonly gitDir: string;
  readonly commonDir: string;
  readonly baseCommit: string;
  readonly configFingerprint: string;
}

export interface CommitResult {
  readonly committed: boolean;
  readonly commit?: string;
  readonly reason?: string;
}

export interface DiffResult {
  readonly text: string;
  readonly truncated: boolean;
}

export interface DiffStatEntry {
  readonly path: string;
  readonly added: number | null;
  readonly removed: number | null;
}

export interface IntegrityReport {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

export interface RepoOps {
  preflight(): Promise<RepoPreflight>;
  addWorktree(runId: string, base: string): Promise<{ readonly path: string; readonly branch: string }>;
  removeWorktree(path: string, options: { readonly force: boolean }): Promise<void>;
  deleteBranch(name: string): Promise<void>;
  stageAll(): Promise<void>;
  commit(message: string): Promise<CommitResult>;
  changedPaths(base: string): Promise<readonly string[]>;
  listIgnored(): Promise<readonly string[]>;
  diff(base: string, maxBytes: number): Promise<DiffResult>;
  diffStat(base: string): Promise<readonly DiffStatEntry[]>;
  isIgnored(paths: readonly string[]): Promise<readonly string[]>;
  checkIntegrity(): Promise<IntegrityReport>;
}
