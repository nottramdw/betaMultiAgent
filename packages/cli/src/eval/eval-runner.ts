import type { AgentRole, TeamOutcome, TeamStatus } from "@betamultiagent/core";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { readAuditLedger } from "../audit/audit-ledger.js";
import type { CliIo, OutputStream } from "../cli-io.js";
import type { MainOverrides } from "../commands/command-context.js";
import { auditDir, userConfigFile } from "../config/paths.js";
import { grantTrust } from "../config/trust.js";
import { CREDENTIAL_VARIABLES, createCliRedactor, ensureStateDir, openWorkspace } from "../wiring.js";
import { JUDGE_TIMEOUT_MS, runJudge, truncateDiff, type JudgeRecord, type JudgeTarget } from "../judge/model-judge.js";
import type { EvalSuite, EvalTask } from "./eval-suite.js";
import type { EvalRoleConfig } from "./eval-variant.js";

const execFileAsync = promisify(execFile);

export const CHECK_TIMEOUT_MS = 120_000;
const TAIL_CHARS = 2000;

export type MainEntry = (argv: readonly string[], io: CliIo, overrides: MainOverrides) => Promise<number>;

export interface EvalRunOptions {
  readonly suite: EvalSuite;
  readonly task: EvalTask;
  readonly attempt: number;
  readonly roles: EvalRoleConfig;
  readonly extraRoots: readonly string[];
  readonly judges: readonly JudgeTarget[];
  readonly maxCostUsd: number;
  readonly maxWallMinutes: number;
  readonly io: CliIo;
  readonly overrides: MainOverrides;
  readonly main: MainEntry;
  readonly keep: boolean;
}

export interface EvalRunRecord {
  readonly taskId: string;
  readonly kind: EvalTask["kind"];
  readonly expect: EvalTask["expect"];
  readonly attempt: number;
  readonly status: TeamStatus | "error";
  readonly code?: string;
  readonly message?: string;
  readonly exitCode: number;
  readonly approved: boolean;
  readonly checkPassed?: boolean;
  readonly checkOutput?: string;
  readonly correct: boolean;
  readonly falseApprove: boolean;
  readonly revisions: number;
  readonly planCorrections: number;
  readonly invalidInputs: number;
  readonly costUsd: number;
  readonly costByRole: Partial<Record<AgentRole, number>>;
  readonly turnsByRole: Partial<Record<AgentRole, number>>;
  readonly durationMs: number;
  readonly judges?: readonly JudgeRecord[];
  readonly workDir?: string;
}

class CaptureStream implements OutputStream {
  readonly isTTY = false;
  text = "";

  write(chunk: string): void {
    this.text += chunk;
  }
}

function tail(text: string): string {
  return text.length <= TAIL_CHARS ? text : text.slice(-TAIL_CHARS);
}

export function teamArgv(task: EvalTask, maxCostUsd: number): string[] {
  return ["team", task.task, ...task.accept.flatMap((item) => ["--accept", item]), "--yes-verify", "--json", "--max-cost", String(maxCostUsd)];
}

function childEnv(env: CliIo["env"]): Record<string, string> {
  const blocked = new Set<string>(CREDENTIAL_VARIABLES);
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && !blocked.has(entry[0])),
  );
}

async function git(cwd: string, env: Record<string, string>, args: readonly string[]): Promise<void> {
  await execFileAsync("git", [...args], { cwd, env, windowsHide: true });
}

async function seedRepository(workspace: string, env: Record<string, string>): Promise<void> {
  await git(workspace, env, ["init", "-q", "-b", "main"]);
  await git(workspace, env, ["config", "user.name", "bma-eval"]);
  await git(workspace, env, ["config", "user.email", "bma-eval@localhost"]);
  await git(workspace, env, ["config", "commit.gpgsign", "false"]);
  await git(workspace, env, ["config", "core.autocrlf", "false"]);
  await git(workspace, env, ["add", "--all"]);
  await git(workspace, env, ["commit", "-q", "-m", "fixture"]);
}

function userConfig(options: EvalRunOptions): string {
  return `${JSON.stringify(
    {
      roles: options.roles,
      ...(options.extraRoots.length === 0 ? {} : { skills: { extraRoots: options.extraRoots } }),
      permissions: {
        rules: [
          { kind: "write", match: "**", decision: "allow" },
          { kind: "exec", match: ["node", "--test"], decision: "allow" },
        ],
      },
      budget: { maxCostUsd: options.maxCostUsd, maxWallMinutes: options.maxWallMinutes },
    },
    null,
    2,
  )}\n`;
}

function parseOutcome(stdout: string): TeamOutcome | undefined {
  const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
  for (const line of lines.reverse()) {
    try {
      const value = JSON.parse(line) as { type?: unknown; outcome?: unknown };
      if (value.type === "team-outcome" && typeof value.outcome === "object" && value.outcome !== null) {
        return value.outcome as TeamOutcome;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

async function runCheck(
  file: string,
  worktree: string,
  baseCommit: string | undefined,
  env: Record<string, string>,
): Promise<{ passed: boolean; output: string }> {
  try {
    const result = await execFileAsync(process.execPath, [file, ...(baseCommit === undefined ? [] : [baseCommit])], {
      cwd: worktree,
      env,
      timeout: CHECK_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { passed: true, output: tail(`${result.stdout}${result.stderr}`) };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    return { passed: false, output: tail(`${failure.stdout ?? ""}${failure.stderr ?? ""}${failure.message ?? ""}`) };
  }
}

async function collectDiff(worktree: string, baseCommit: string, env: Record<string, string>): Promise<{ readonly text: string; readonly truncated: boolean }> {
  await git(worktree, env, ["add", "--all"]);
  const result = await execFileAsync("git", ["diff", "--cached", "--no-color", "--no-ext-diff", baseCommit], {
    cwd: worktree,
    env,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  return truncateDiff(result.stdout);
}

async function gradeRun(options: EvalRunOptions, outcome: TeamOutcome | undefined, env: Record<string, string>): Promise<JudgeRecord[] | undefined> {
  if (options.judges.length === 0) {
    return undefined;
  }
  if (outcome?.worktreePath === undefined || outcome.baseCommit === undefined) {
    return options.judges.map((judge) => ({ model: judge.label, status: "skipped", message: "the run left no worktree to grade", costUsd: 0 }));
  }
  const diff = await collectDiff(outcome.worktreePath, outcome.baseCommit, env);
  const records: JudgeRecord[] = [];
  for (const judge of options.judges) {
    const input = {
      goal: options.task.task,
      acceptance: options.task.accept,
      rubric: options.task.rubric,
      diff: diff.text,
      diffTruncated: diff.truncated,
      verification: outcome.verificationRuns,
    };
    records.push(await runJudge(judge, input, AbortSignal.timeout(JUDGE_TIMEOUT_MS)));
  }
  return records;
}

export function judgeRun(
  task: EvalTask,
  approved: boolean,
  checkPassed: boolean | undefined,
): { correct: boolean; falseApprove: boolean } {
  if (task.expect === "not-approved") {
    return { correct: !approved, falseApprove: approved };
  }
  const falseApprove = approved && checkPassed === false;
  return { correct: approved && checkPassed !== false, falseApprove };
}

export async function runEvalTask(options: EvalRunOptions): Promise<EvalRunRecord> {
  const { task, io } = options;
  const started = Date.now();
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "bma-eval-")));
  const workspace = path.join(base, "workspace");
  const home = path.join(base, "home");
  const env = childEnv(io.env);
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const nested: CliIo = {
    ...io,
    stdout,
    stderr,
    stdinIsTTY: false,
    cwd: workspace,
    env: { ...io.env, BMA_HOME: home },
  };
  try {
    await cp(path.join(options.suite.fixturesDir, task.fixture), workspace, { recursive: true });
    await seedRepository(workspace, env);
    const opened = await openWorkspace(nested, createCliRedactor(nested.env));
    await mkdir(opened.dirs.config, { recursive: true });
    await writeFile(userConfigFile(opened.dirs), userConfig(options));
    await ensureStateDir(opened.dirs);
    await grantTrust(opened.dirs, opened.root, opened.digest, io.now());
    const argv = teamArgv(task, options.maxCostUsd);
    const exitCode = await options.main(argv, nested, options.overrides);
    const outcome = parseOutcome(stdout.text);
    const records = await readAuditLedger(auditDir(opened.dirs, opened.root), () => undefined);
    const ledgerOutcome = records.find((record) => record.kind === "run-outcome" && record.runId === outcome?.runId);
    const check =
      task.check !== undefined && outcome?.worktreePath !== undefined
        ? await runCheck(path.join(options.suite.dir, "checks", task.check), outcome.worktreePath, outcome.baseCommit, env)
        : undefined;
    const judges = await gradeRun(options, outcome, env);
    const approved = outcome?.status === "approved";
    const verdict = judgeRun(task, approved, check?.passed);
    const byRole = outcome?.usageByRole ?? {};
    return {
      taskId: task.id,
      kind: task.kind,
      expect: task.expect,
      attempt: options.attempt,
      status: outcome?.status ?? "error",
      ...(outcome?.code === undefined ? {} : { code: outcome.code }),
      ...(outcome === undefined ? { message: tail(stderr.text) } : outcome.message === undefined ? {} : { message: outcome.message }),
      exitCode,
      approved,
      ...(check === undefined ? {} : { checkPassed: check.passed, checkOutput: check.output }),
      ...verdict,
      revisions: outcome?.revisions ?? 0,
      planCorrections: outcome?.planCorrections ?? 0,
      invalidInputs: ledgerOutcome?.kind === "run-outcome" ? ledgerOutcome.invalidInputs : 0,
      costUsd: outcome?.usage.costUsd ?? 0,
      costByRole: Object.fromEntries(Object.entries(byRole).map(([role, usage]) => [role, usage.costUsd])),
      turnsByRole: Object.fromEntries(Object.entries(byRole).map(([role, usage]) => [role, usage.turns])),
      durationMs: Date.now() - started,
      ...(judges === undefined ? {} : { judges }),
      ...(options.keep ? { workDir: base } : {}),
    };
  } catch (error) {
    return {
      taskId: task.id,
      kind: task.kind,
      expect: task.expect,
      attempt: options.attempt,
      status: "error",
      message: tail(`${error instanceof Error ? error.message : String(error)}\n${stderr.text}`),
      exitCode: -1,
      approved: false,
      correct: false,
      falseApprove: false,
      revisions: 0,
      planCorrections: 0,
      invalidInputs: 0,
      costUsd: 0,
      costByRole: {},
      turnsByRole: {},
      durationMs: Date.now() - started,
      ...(options.keep ? { workDir: base } : {}),
    };
  } finally {
    if (!options.keep) {
      await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
    }
  }
}
