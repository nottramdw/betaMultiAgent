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
import { CommandApprovalTracker } from "../audit/audit-recorder.js";
import { EXIT_BUDGET, EXIT_FAILED, EXIT_INTERRUPTED, EXIT_OK, EXIT_STOPPED, usageError } from "../cli-error.js";
import { runsDir, samePath, sessionsDir, worktreesDir } from "../config/paths.js";
import { readPromptFile } from "../input/prompt-file.js";
import { HumanRenderer, type TerminalWriter } from "../output/human.js";
import { JsonlWriter } from "../output/jsonl.js";
import { displayArgv, displayValue } from "../output/sanitize.js";
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

function parseCost(text: string | undefined): number | undefined {
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
      json: { type: "boolean", default: false },
    },
  });
  const acceptance = values.accept ?? [];
  const invalidAcceptance = acceptanceProblems(acceptance);
  if (invalidAcceptance.length > 0) {
    throw usageError(`--accept: ${invalidAcceptance.join("; ")}`);
  }
  const maxCost = parseCost(values["max-cost"]);
  const task = await readTask(context, values["task-file"], positionals);
  const workspace = await openWorkspace(context.io, context.redactor);
  for (const warning of workspace.config.warnings) {
    context.err.line(`bma: ${warning}`);
  }
  if (!workspace.trusted) {
    context.err.line(untrustedWarning());
  }
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
  const opened: OpenedChannel | undefined = isInteractive(context, values.json) ? openPromptChannel(context) : undefined;
  let approveCommands: CommandApprover | undefined;
  let tracker: CommandApprovalTracker | undefined;
  if (workspace.trusted && values["yes-verify"]) {
    tracker = new CommandApprovalTracker("yes-verify");
    approveCommands = tracker.wrap(() => Promise.resolve(true));
  } else if (workspace.trusted && opened !== undefined) {
    tracker = new CommandApprovalTracker("tty");
    approveCommands = tracker.wrap(createTtyCommandApprover(opened.channel));
  }
  const human = values.json ? undefined : new HumanRenderer({ stdout: context.out, stderr: context.err, streamText: false });
  const jsonl = values.json ? new JsonlWriter(context.io.stdout, context.redactor) : undefined;
  const listeners: EventListener[] = [human ?? jsonl].filter((entry) => entry !== undefined);
  const store = await SessionStore.open({ dir: runDir, redactor: context.redactor });
  const mainEnvironment = createEnvironment(workspace, skills, workspace.root, "local");
  const maxWallMs = wallMs(workspace.config.budget);
  const maxCostUsd = lowest(workspace.config.budget.maxCostUsd, maxCost);
  const controller = new AbortController();
  const uninstall = installInterruptHandler({
    signals: context.io.signals,
    controller,
    notify: (message) => {
      context.err.line(message);
    },
    exit: context.io.exit,
    ...(context.overrides.killProcessTrees === undefined ? {} : { killProcessTrees: context.overrides.killProcessTrees }),
  });
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
  });
  let outcome: TeamOutcome | undefined;
  try {
    outcome = await runTeam(task, {
      runId,
      root: workspace.root,
      trusted: workspace.trusted,
      allowDirty: values["allow-dirty"],
      ...(acceptance.length === 0 ? {} : { acceptance }),
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
        audit.recorder.tap(
          await SessionStore.open({ dir: path.join(sessionsDir(workspace.dirs, workspace.root), id), redactor: context.redactor }),
          id,
          role,
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
  }
  if (jsonl !== undefined) {
    jsonl.writeResult("team-outcome", { outcome });
  } else {
    printTeamSummary(context.out, outcome);
  }
  return teamExitCode(outcome.status);
}
