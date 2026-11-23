import {
  acceptanceProblems,
  runTeam,
  SessionStore,
  ulid,
  type CommandApprover,
  type EventBody,
  type EventListener,
  type EventSink,
  type TeamOutcome,
  type TeamStatus,
} from "@betamultiagent/core";
import { createRepoOps } from "@betamultiagent/tools";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { createTtyApprover, createTtyCommandApprover } from "../approver/tty-approver.js";
import { openAudit } from "../audit/open-audit.js";
import type { DailySpend } from "../budget/daily-spend.js";
import { openDailySpend, reserveRunBudget, trackSpend } from "../budget/run-budget.js";
import { CommandApprovalTracker } from "../audit/audit-recorder.js";
import { EXIT_BUDGET, EXIT_FAILED, EXIT_INTERRUPTED, EXIT_OK, EXIT_STOPPED, usageError } from "../cli-error.js";
import { runsDir, samePath, sessionsDir, worktreesDir } from "../config/paths.js";
import { readPromptFile } from "../input/prompt-file.js";
import { parseJudgeSpecs, resolveJudges } from "../judge/model-judge.js";
import { HumanRenderer, type TerminalWriter } from "../output/human.js";
import { JsonlWriter } from "../output/jsonl.js";
import { displayArgv, displayValue } from "../output/sanitize.js";
import { buildPanel, gradeCandidate, MAX_CANDIDATES, MIN_CANDIDATES, printPanelSummary, type PanelResult } from "../panel/team-panel.js";
import { installInterruptHandler } from "../process/interrupt.js";
import {
  createEnvironment,
  createModelResolver,
  createPermissionEngine,
  createTools,
  ensureStateDir,
  loadSkills,
  openWorkspace,
  skillCatalog,
  teamRoles,
  untrustedWarning,
  wallMs,
  type Workspace,
} from "../wiring.js";
import { isInteractive, openPromptChannel, type CommandContext, type OpenedChannel } from "./command-context.js";
import { teamCleanCommand } from "./team-clean.js";

const STATUS_EXIT: Readonly<Record<TeamStatus, number>> = {
  approved: EXIT_OK,
  failed: EXIT_FAILED,
  "budget-exceeded": EXIT_BUDGET,
  "needs-human": EXIT_STOPPED,
  blocked: EXIT_STOPPED,
  aborted: EXIT_INTERRUPTED,
};

export function teamExitCode(status: TeamStatus): number {
  return STATUS_EXIT[status];
}

export function parseCost(text: string | undefined): number | undefined {
  if (text === undefined) {
    return undefined;
  }
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) {
    throw usageError(`--max-cost must be a positive number of US dollars, got ${JSON.stringify(text)}`);
  }
  return value;
}

function lowest(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) {
    return b;
  }
  return b === undefined ? a : Math.min(a, b);
}

export function printTeamSummary(out: TerminalWriter, outcome: TeamOutcome): void {
  out.line(`team run ${outcome.runId}: ${outcome.status}${outcome.code === undefined ? "" : ` (${outcome.code})`}`);
  if (outcome.message !== undefined) {
    out.line(`  ${outcome.message}`);
  }
  if (outcome.plan !== undefined) {
    out.line(`plan: ${outcome.plan.title}`);
  }
  if (outcome.branch !== undefined) {
    out.line(`branch: ${outcome.branch}${outcome.commit === undefined ? "" : ` at ${outcome.commit.slice(0, 12)}`}`);
  }
  if (outcome.commitError !== undefined) {
    out.line(`commit failed: ${outcome.commitError}`);
  }
  if (outcome.worktreePath !== undefined) {
    out.line(`worktree: ${outcome.worktreePath}`);
  }
  if (outcome.stopped !== undefined) {
    out.line(`executor claim, stop condition: ${displayValue(outcome.stopped.condition)}`);
    out.line(`  evidence: ${displayValue(outcome.stopped.evidence, 500)}`);
  }
  if (outcome.criteria !== undefined) {
    out.line("acceptance criteria (reviewer assessment):");
    for (const criterion of outcome.criteria) {
      out.line(`  ${criterion.id} ${criterion.status} [${criterion.source}]: ${displayValue(criterion.text)}`);
      if (criterion.status !== "PASS") {
        out.line(`    ${displayValue(criterion.note, 500)}`);
      }
    }
  } else if (outcome.acceptance !== undefined) {
    out.line("acceptance criteria (not assessed):");
    for (const criterion of outcome.acceptance) {
      out.line(`  ${criterion.id} [${criterion.source}]: ${displayValue(criterion.text)}`);
    }
  }
  if (outcome.open !== undefined) {
    out.line("unfinished work (executor claim):");
    for (const item of outcome.open) {
      out.line(`  ${displayValue(item)}`);
    }
  }
  out.line(`verification (run by the harness): ${outcome.verification}`);
  if (outcome.verification === "skipped" && outcome.unapprovedCommands.length > 0) {
    out.line("  not approved, so not run:");
    for (const command of outcome.unapprovedCommands) {
      out.line(`    ${displayArgv(command.argv)}`);
    }
  }
  for (const run of outcome.verificationRuns.filter((entry) => !entry.ok)) {
    out.line(`  failed: ${displayArgv(run.command.argv)} (exit ${String(run.exitCode)}${run.timedOut ? ", timed out" : ""})`);
  }
  if (outcome.sensitiveChanges.length > 0) {
    out.line("SENSITIVE CHANGES (build, CI, package or agent configuration), review these first:");
    for (const file of outcome.sensitiveChanges) {
      out.line(`  ${file}`);
    }
  }
  out.line(`revisions: ${String(outcome.revisions)}, cost: $${outcome.usage.costUsd.toFixed(4)}`);
  if (outcome.branch !== undefined && outcome.baseCommit !== undefined) {
    out.line(`Review the diff before merging: git diff ${outcome.baseCommit.slice(0, 12)}..${outcome.branch}`);
  }
}

class TeeSink implements EventSink {
  readonly #store: SessionStore;
  readonly #listeners: readonly EventListener[];

  constructor(store: SessionStore, listeners: readonly EventListener[]) {
    this.#store = store;
    this.#listeners = listeners;
  }

  async append(body: EventBody) {
    const record = await this.#store.append(body);
    for (const listener of this.#listeners) {
      listener.onRecord?.(record);
    }
    return record;
  }
}

async function readTask(context: CommandContext, file: string | undefined, positionals: readonly string[]): Promise<string> {
  if (file !== undefined && positionals.length > 0) {
    throw usageError("give the task either as an argument or with --task-file, not both");
  }
  const task = file === undefined ? positionals.join(" ") : await readPromptFile(path.resolve(context.io.cwd, file));
  if (task.trim().length === 0) {
    throw usageError("missing task; usage: bma team <task>");
  }
  return task;
}

export async function teamCommand(context: CommandContext, args: readonly string[]): Promise<number> {
  if (args[0] === "clean") {
    return teamCleanCommand(context, args.slice(1));
  }
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      "task-file": { type: "string", short: "f" },
      "allow-dirty": { type: "boolean", default: false },
      "max-cost": { type: "string" },
      "yes-verify": { type: "boolean", default: false },
      accept: { type: "string", multiple: true },
      candidates: { type: "string" },
      judge: { type: "string", multiple: true },
      json: { type: "boolean", default: false },
    },
  });
  const candidates = parseCandidates(values.candidates);
  const judgeSpecs = values.judge ?? [];
  if (judgeSpecs.length > 0 && candidates === undefined) {
    throw usageError("--judge needs --candidates");
  }
  const judgeRefs = parseJudgeSpecs(judgeSpecs);
  const acceptance = values.accept ?? [];
  const invalidAcceptance = acceptanceProblems(acceptance);
  if (invalidAcceptance.length > 0) {
    throw usageError(`--accept: ${invalidAcceptance.join("; ")}`);
  }
  const maxCost = parseCost(values["max-cost"]);
  const task = await readTask(context, values["task-file"], positionals);
  const workspace = await openWorkspace(context.io, context.redactor);
  reportWorkspace(context, workspace);
  const input: TeamExecution = {
    task,
    acceptance,
    allowDirty: values["allow-dirty"],
    ...(maxCost === undefined ? {} : { maxCost }),
    yesVerify: values["yes-verify"],
    json: values.json,
  };
  if (candidates !== undefined) {
    const judges = resolveJudges(judgeRefs, context.io.env, context.overrides);
    if (!input.yesVerify) {
      context.err.line("bma: without --yes-verify the panel skips verification, so no candidate can be selected");
    }
    const panel = await runPanel(context, workspace, input, candidates, judges);
    return panelExitCode(panel);
  }
  const outcome = await executeTeam(context, workspace, input);
  return teamExitCode(outcome.status);
}

function parseCandidates(text: string | undefined): number | undefined {
  if (text === undefined) {
    return undefined;
  }
  const value = Number(text);
  if (!Number.isInteger(value) || value < MIN_CANDIDATES || value > MAX_CANDIDATES) {
    throw usageError(`--candidates must be an integer from ${String(MIN_CANDIDATES)} to ${String(MAX_CANDIDATES)}, got ${JSON.stringify(text)}`);
  }
  return value;
}

function panelExitCode(panel: PanelResult): number {
  if (panel.selected !== undefined) {
    return EXIT_OK;
  }
  if (panel.candidates.some((candidate) => candidate.status === "approved")) {
    return EXIT_STOPPED;
  }
  const first = panel.candidates[0];
  return first === undefined ? EXIT_FAILED : teamExitCode(first.status);
}

async function settleAll<T>(work: readonly Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(work);
  const failure = settled.find((entry) => entry.status === "rejected");
  if (failure !== undefined) {
    throw failure.reason;
  }
  return settled.map((entry) => (entry as PromiseFulfilledResult<T>).value);
}

async function runPanel(
  context: CommandContext,
  workspace: Workspace,
  input: TeamExecution,
  count: number,
  judges: ReturnType<typeof resolveJudges>,
): Promise<PanelResult> {
  const daily = openDailySpend(context, workspace);
  const candidateInput = await panelCandidateInput(workspace, input, count, daily);
  const controller = new AbortController();
  const uninstall = installRunInterrupt(context, controller);
  try {
    const outcomes = await settleAll(
      Array.from({ length: count }, () => executeTeam(context, workspace, { ...candidateInput, quiet: true, signal: controller.signal })),
    );
    const grading = {
      goal: input.task,
      acceptance: input.acceptance,
      judges,
      root: workspace.root,
      env: context.io.env,
      signal: controller.signal,
      ...(daily === undefined ? {} : { spend: { allowed: () => daily.hasRemaining(), charge: (costUsd: number) => daily.charge(costUsd) } }),
    };
    const grades = await settleAll(outcomes.map((outcome) => gradeCandidate(outcome, grading)));
    const panel = buildPanel(outcomes, grades);
    if (input.json) {
      new JsonlWriter(context.io.stdout, context.redactor).writeResult("team-panel", { panel });
    } else {
      printPanelSummary(context.out, panel);
    }
    return panel;
  } finally {
    uninstall();
  }
}

async function panelCandidateInput(workspace: Workspace, input: TeamExecution, count: number, daily: DailySpend | undefined): Promise<TeamExecution> {
  if (daily === undefined || lowest(workspace.config.budget.maxCostUsd, input.maxCost) !== undefined) {
    return input;
  }
  const { remainingUsd } = await daily.summary();
  return remainingUsd > 0 ? { ...input, maxCost: remainingUsd / count } : input;
}

export function installRunInterrupt(context: CommandContext, controller: AbortController): () => void {
  return installInterruptHandler({
    signals: context.io.signals,
    controller,
    notify: (message) => {
      context.err.line(message);
    },
    exit: context.io.exit,
    ...(context.overrides.killProcessTrees === undefined ? {} : { killProcessTrees: context.overrides.killProcessTrees }),
  });
}

function linkSignal(signal: AbortSignal, controller: AbortController): () => void {
  const onAbort = (): void => {
    controller.abort();
  };
  if (signal.aborted) {
    controller.abort();
    return () => undefined;
  }
  signal.addEventListener("abort", onAbort, { once: true });
  return () => {
    signal.removeEventListener("abort", onAbort);
  };
}

export function reportWorkspace(context: CommandContext, workspace: Workspace): void {
  for (const warning of workspace.config.warnings) {
    context.err.line(`bma: ${warning}`);
  }
  if (!workspace.trusted) {
    context.err.line(untrustedWarning());
  }
}

export interface TeamExecution {
  readonly task: string;
  readonly acceptance: readonly string[];
  readonly allowDirty: boolean;
  readonly maxCost?: number;
  readonly yesVerify: boolean;
  readonly json: boolean;
  readonly taskId?: string;
  readonly quiet?: boolean;
  readonly signal?: AbortSignal;
}

export async function executeTeam(context: CommandContext, workspace: Workspace, input: TeamExecution): Promise<TeamOutcome> {
  const { task, acceptance } = input;
  const roles = teamRoles(workspace, context.overrides);
  const resolveModel = createModelResolver(context.io.env, context.overrides);
  for (const role of Object.values(roles)) {
    resolveModel(role.model);
  }
  const skills = await loadSkills(workspace);
  for (const warning of skills.warnings) {
    context.err.line(`bma: skills: ${warning}`);
  }
  await ensureStateDir(workspace.dirs);
  const runId = ulid(context.io.now().getTime());
  const runDir = path.join(runsDir(workspace.dirs, workspace.root), runId);
  const hooksDir = path.join(runDir, "hooks");
  await mkdir(hooksDir, { recursive: true, mode: 0o700 });
  const repoOptions = {
    hooksDir,
    worktreesDir: worktreesDir(workspace.dirs),
    baseEnv: context.io.env,
    envPassthrough: workspace.config.passthrough,
  };
  const quiet = input.quiet === true;
  const opened: OpenedChannel | undefined = !quiet && isInteractive(context, input.json) ? openPromptChannel(context) : undefined;
  let approveCommands: CommandApprover | undefined;
  let tracker: CommandApprovalTracker | undefined;
  if (workspace.trusted && input.yesVerify) {
    tracker = new CommandApprovalTracker("yes-verify");
    approveCommands = tracker.wrap(() => Promise.resolve(true));
  } else if (workspace.trusted && opened !== undefined) {
    tracker = new CommandApprovalTracker("tty");
    approveCommands = tracker.wrap(createTtyCommandApprover(opened.channel));
  }
  const human = input.json ? undefined : new HumanRenderer({ stdout: context.out, stderr: context.err, streamText: false });
  const jsonl = input.json ? new JsonlWriter(context.io.stdout, context.redactor) : undefined;
  const listeners: EventListener[] = quiet ? [] : [human ?? jsonl].filter((entry) => entry !== undefined);
  const store = await SessionStore.open({ dir: runDir, redactor: context.redactor });
  const mainEnvironment = createEnvironment(workspace, skills, workspace.root, "local");
  const maxWallMs = wallMs(workspace.config.budget);
  const runBudget = await reserveRunBudget(context, workspace, lowest(workspace.config.budget.maxCostUsd, input.maxCost));
  const maxCostUsd = runBudget.maxCostUsd;
  const controller = new AbortController();
  const uninstall = input.signal === undefined ? installRunInterrupt(context, controller) : linkSignal(input.signal, controller);
  const catalog = skillCatalog(skills);
  const audit = await openAudit(context, workspace, runId);
  audit.recorder.start({
    command: "team",
    roles: Object.fromEntries(Object.entries(roles).map(([role, config]) => [role, config.model])),
    budget: {
      ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
      ...(maxWallMs === undefined ? {} : { maxWallMs }),
    },
    task,
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
  });
  let outcome: TeamOutcome | undefined;
  try {
    outcome = await runTeam(task, {
      runId,
      root: workspace.root,
      trusted: workspace.trusted,
      allowDirty: input.allowDirty,
      ...(acceptance.length === 0 ? {} : { acceptance: [...acceptance] }),
      roles,
      repo: createRepoOps({ repoRoot: workspace.root, ...repoOptions }),
      openRepo: (root) => createRepoOps({ repoRoot: root, ...repoOptions }),
      environments: {
        create: (root) =>
          Promise.resolve(createEnvironment(workspace, skills, root, samePath(root, workspace.root, context.io.platform) ? "local" : "git-worktree")),
      },
      resolveModel,
      toolsFor: (_role, environment) => createTools(environment, skills),
      permissionsFor: (role, environment) =>
        createPermissionEngine(workspace, environment, skills, opened === undefined ? undefined : createTtyApprover(opened.channel, role)),
      commandPolicy: createPermissionEngine(workspace, mainEnvironment, skills, undefined),
      ...(approveCommands === undefined ? {} : { approveCommands }),
      setup: workspace.config.setup.map((argv) => ({ argv: [...argv] })),
      budget: {
        ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
        ...(maxWallMs === undefined ? {} : { maxWallMs }),
      },
      events: new TeeSink(store, listeners),
      openSessionLog: async (id, role) =>
        trackSpend(
          audit.recorder.tap(
            await SessionStore.open({ dir: path.join(sessionsDir(workspace.dirs, workspace.root), id), redactor: context.redactor }),
            id,
            role,
          ),
          runBudget.reservation,
        ),
      redactor: context.redactor,
      ...(catalog === undefined ? {} : { skillCatalog: catalog }),
      listeners,
      platform: context.io.platform,
      now: context.io.now,
      signal: controller.signal,
    });
  } finally {
    uninstall();
    opened?.close();
    await store.close();
    if (outcome !== undefined) {
      audit.recorder.teamOutcome(outcome, workspace.trusted, tracker);
    }
    await audit.ledger.close();
    await runBudget.reservation?.release();
  }
  if (jsonl !== undefined) {
    jsonl.writeResult("team-outcome", { outcome });
  } else {
    printTeamSummary(context.out, outcome);
  }
  return outcome;
}
