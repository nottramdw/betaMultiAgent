import { acceptanceProblems, ulid, type TeamStatus, type TurnOutcome } from "@betamultiagent/core";
import path from "node:path";
import { parseArgs } from "node:util";
import { CliError, EXIT_BUDGET, EXIT_FAILED, EXIT_OK, errorMessage, usageError } from "../cli-error.js";
import { tasksDir } from "../config/paths.js";
import { readPromptFile } from "../input/prompt-file.js";
import { JsonlWriter } from "../output/jsonl.js";
import { displayValue } from "../output/sanitize.js";
import { acquireRunnerLock, defaultLockEnvironment, RunnerLockError, type RunnerLock } from "../tasks/runner-lock.js";
import {
  dependenciesDone,
  findTask,
  isReady,
  MAX_GOAL_LENGTH,
  MAX_TITLE_LENGTH,
  TaskLookupError,
  TaskStatusSchema,
  TaskStore,
  type TaskSpec,
  type TaskState,
  type TaskStatus,
} from "../tasks/task-store.js";
import { openWorkspace, type Workspace } from "../wiring.js";
import type { CommandContext } from "./command-context.js";
import { executeRun, runExitCode } from "./run.js";
import { executeTeam, installRunInterrupt, parseCost, reportWorkspace, teamExitCode } from "./team.js";

const DEFAULT_TITLE_LENGTH = 80;
const MAX_PARALLEL = 4;
const RERUNNABLE: ReadonlySet<TaskStatus> = new Set(["open", "failed", "needs-human"]);

const TEAM_STATUS: Readonly<Record<TeamStatus, TaskStatus>> = {
  approved: "done",
  "needs-human": "needs-human",
  blocked: "needs-human",
  failed: "failed",
  "budget-exceeded": "failed",
  aborted: "open",
};

function runStatus(outcome: TurnOutcome): TaskStatus {
  switch (outcome.type) {
    case "completed":
      return "done";
    case "refused":
      return "needs-human";
    case "aborted":
      return "open";
    case "budget-exceeded":
    case "loop-detected":
    case "max-tokens":
    case "failed":
      return "failed";
  }
}

interface Opened {
  readonly workspace: Workspace;
  readonly store: TaskStore;
}

async function openStore(context: CommandContext): Promise<Opened> {
  const workspace = await openWorkspace(context.io, context.redactor);
  const store = new TaskStore(tasksDir(workspace.dirs, workspace.root), context.redactor, context.io.now, (message) => {
    context.err.line(`bma: tasks: ${message}`);
  });
  return { workspace, store };
}

function lookup(tasks: readonly TaskState[], reference: string): TaskState {
  try {
    return findTask(tasks, reference);
  } catch (error) {
    if (error instanceof TaskLookupError) {
      throw usageError(error.message);
    }
    throw error;
  }
}

function defaultTitle(goal: string): string {
  const line = goal.split(/\r?\n/u).find((entry) => entry.trim().length > 0)?.trim() ?? goal.trim();
  return line.length > DEFAULT_TITLE_LENGTH ? `${line.slice(0, DEFAULT_TITLE_LENGTH - 1)}…` : line;
}

function summary(task: TaskState): Omit<TaskState, "history"> {
  return {
    id: task.id,
    title: task.title,
    goal: task.goal,
    mode: task.mode,
    acceptance: task.acceptance,
    dependencies: task.dependencies,
    ...(task.parent === undefined ? {} : { parent: task.parent }),
    createdAt: task.createdAt,
    status: task.status,
    updatedAt: task.updatedAt,
  };
}

async function addTask(context: CommandContext, args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      "goal-file": { type: "string", short: "f" },
      title: { type: "string" },
      accept: { type: "string", multiple: true },
      after: { type: "string", multiple: true },
      parent: { type: "string" },
      ask: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  });
  if (values["goal-file"] !== undefined && positionals.length > 0) {
    throw usageError("give the goal either as an argument or with --goal-file, not both");
  }
  const goal = values["goal-file"] === undefined ? positionals.join(" ") : await readPromptFile(path.resolve(context.io.cwd, values["goal-file"]));
  if (goal.trim().length === 0) {
    throw usageError("missing goal; usage: bma task add <goal>");
  }
  if (goal.length > MAX_GOAL_LENGTH) {
    throw usageError(`the goal exceeds ${String(MAX_GOAL_LENGTH)} characters`);
  }
  const title = values.title?.trim() ?? defaultTitle(goal);
  if (title.length === 0 || title.length > MAX_TITLE_LENGTH) {
    throw usageError(`--title must have 1 to ${String(MAX_TITLE_LENGTH)} characters`);
  }
  const acceptance = values.accept ?? [];
  if (values.ask && acceptance.length > 0) {
    throw usageError("--accept applies to team tasks; a task added with --ask is answered without review");
  }
  const problems = acceptanceProblems(acceptance);
  if (problems.length > 0) {
    throw usageError(`--accept: ${problems.join("; ")}`);
  }
  const { store } = await openStore(context);
  const tasks = await store.load();
  const dependencies: string[] = [];
  for (const reference of values.after ?? []) {
    const dependency = lookup(tasks, reference);
    if (dependency.status === "cancelled") {
      throw usageError(`--after: task ${dependency.id} is cancelled`);
    }
    if (!dependencies.includes(dependency.id)) {
      dependencies.push(dependency.id);
    }
  }
  const parent = values.parent === undefined ? undefined : lookup(tasks, values.parent).id;
  const now = context.io.now();
  const spec: TaskSpec = {
    id: ulid(now.getTime()),
    title,
    goal,
    mode: values.ask ? "ask" : "team",
    acceptance: [...acceptance],
    dependencies,
    ...(parent === undefined ? {} : { parent }),
    createdAt: now.toISOString(),
  };
  const stored = await store.add(spec);
  if (values.json) {
    new JsonlWriter(context.io.stdout, context.redactor).writeResult("task-added", { task: stored });
  } else {
    context.out.line(`task ${stored.id} added (${stored.mode}): ${displayValue(stored.title)}`);
  }
  return EXIT_OK;
}

async function listTasks(context: CommandContext, args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: { status: { type: "string" }, json: { type: "boolean", default: false } },
  });
  if (positionals.length > 0) {
    throw usageError("bma task list takes no positional arguments");
  }
  const status = values.status === undefined ? undefined : TaskStatusSchema.safeParse(values.status);
  if (status !== undefined && !status.success) {
    throw usageError(`--status must be one of ${TaskStatusSchema.options.join(", ")}`);
  }
  const { store } = await openStore(context);
  const tasks = (await store.load()).filter((task) => status === undefined || task.status === status.data);
  if (values.json) {
    new JsonlWriter(context.io.stdout, context.redactor).writeResult("task-list", { tasks: tasks.map(summary) });
    return EXIT_OK;
  }
  if (tasks.length === 0) {
    context.out.line("no tasks");
    return EXIT_OK;
  }
  for (const task of tasks) {
    const after = task.dependencies.length === 0 ? "" : ` (after ${task.dependencies.join(", ")})`;
    context.out.line(`${task.id}  ${task.status.padEnd(11)}  ${task.mode.padEnd(4)}  ${displayValue(task.title)}${after}`);
  }
  return EXIT_OK;
}

async function showTask(context: CommandContext, args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: { json: { type: "boolean", default: false } },
  });
  const [reference, ...extra] = positionals;
  if (reference === undefined || extra.length > 0) {
    throw usageError("usage: bma task show <id>");
  }
  const { store } = await openStore(context);
  const tasks = await store.load();
  const task = lookup(tasks, reference);
  if (values.json) {
    new JsonlWriter(context.io.stdout, context.redactor).writeResult("task", { task });
    return EXIT_OK;
  }
  const out = context.out;
  out.line(`task ${task.id}: ${task.status}`);
  out.line(`title: ${displayValue(task.title)}`);
  out.line(`mode: ${task.mode}`);
  out.line(`created: ${task.createdAt}`);
  if (task.parent !== undefined) {
    out.line(`parent: ${task.parent}`);
  }
  for (const id of task.dependencies) {
    out.line(`after: ${id} (${tasks.find((candidate) => candidate.id === id)?.status ?? "missing"})`);
  }
  out.line("goal:");
  for (const line of task.goal.split(/\r?\n/u)) {
    out.line(`  ${displayValue(line, 2000)}`);
  }
  if (task.acceptance.length > 0) {
    out.line("acceptance criteria:");
    for (const criterion of task.acceptance) {
      out.line(`  ${displayValue(criterion)}`);
    }
  }
  if (task.history.length > 0) {
    out.line("history:");
    for (const entry of task.history) {
      const details = [entry.runId === undefined ? undefined : `run ${entry.runId}`, entry.code, entry.message === undefined ? undefined : displayValue(entry.message, 500)]
        .filter((part) => part !== undefined)
        .join(", ");
      out.line(`  ${entry.ts} ${entry.status}${details.length === 0 ? "" : `: ${details}`}`);
    }
  }
  return EXIT_OK;
}

async function cancelTask(context: CommandContext, args: readonly string[]): Promise<number> {
  const { positionals } = parseArgs({ args: [...args], allowPositionals: true, strict: true, options: {} });
  const [reference, ...extra] = positionals;
  if (reference === undefined || extra.length > 0) {
    throw usageError("usage: bma task cancel <id>");
  }
  const { store } = await openStore(context);
  const task = lookup(await store.load(), reference);
  if (!RERUNNABLE.has(task.status)) {
    throw usageError(`task ${task.id} is ${task.status} and cannot be cancelled`);
  }
  await store.setStatus({ id: task.id, status: "cancelled" });
  context.out.line(`task ${task.id} cancelled`);
  return EXIT_OK;
}

function pickTask(tasks: readonly TaskState[], reference: string | undefined): TaskState | undefined {
  if (reference === undefined) {
    return tasks.find((task) => isReady(task, tasks));
  }
  const task = lookup(tasks, reference);
  if (!RERUNNABLE.has(task.status)) {
    throw usageError(`task ${task.id} is ${task.status}; only open, failed or needs-human tasks can run`);
  }
  if (!dependenciesDone(task, tasks)) {
    const pending = task.dependencies.filter((id) => tasks.find((candidate) => candidate.id === id)?.status !== "done");
    throw usageError(`task ${task.id} waits for ${pending.join(", ")}`);
  }
  return task;
}

async function lockRunner(context: CommandContext, store: TaskStore): Promise<RunnerLock> {
  try {
    const lock = await acquireRunnerLock(store.dir, defaultLockEnvironment(context.io.now));
    if (lock.replaced !== undefined) {
      context.err.line(`bma: replaced a stale task runner lock from pid ${String(lock.replaced.pid)} (since ${lock.replaced.startedAt})`);
    }
    return lock;
  } catch (error) {
    if (error instanceof RunnerLockError) {
      throw new CliError(EXIT_FAILED, error.message);
    }
    throw error;
  }
}

async function resetInterrupted(store: TaskStore): Promise<void> {
  for (const task of await store.load()) {
    if (task.status === "running") {
      await store.setStatus({
        id: task.id,
        status: "failed",
        code: "interrupted",
        message: "the previous task runner stopped before this task finished",
      });
    }
  }
}

interface TaskRunOptions {
  readonly allowDirty: boolean;
  readonly maxCost?: number;
  readonly yesVerify: boolean;
  readonly json: boolean;
  readonly quiet?: boolean;
  readonly signal?: AbortSignal;
}

interface TaskRunResult {
  readonly status: TaskStatus;
  readonly exitCode: number;
}

interface RunSummary {
  readonly executed: number;
  readonly exitCode?: number;
}

type Settled = { readonly id: string; readonly result: TaskRunResult } | { readonly id: string; readonly error: unknown };

function parseParallel(text: string | undefined): number {
  if (text === undefined) {
    return 1;
  }
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1 || value > MAX_PARALLEL) {
    throw usageError(`--parallel must be an integer from 1 to ${String(MAX_PARALLEL)}, got ${JSON.stringify(text)}`);
  }
  return value;
}

async function executeTask(context: CommandContext, workspace: Workspace, store: TaskStore, task: TaskState, options: TaskRunOptions): Promise<TaskRunResult> {
  await store.setStatus({ id: task.id, status: "running" });
  let result: TaskRunResult & { readonly runId: string; readonly code?: string; readonly message?: string };
  try {
    if (task.mode === "team") {
      const outcome = await executeTeam(context, workspace, {
        task: task.goal,
        acceptance: task.acceptance,
        allowDirty: options.allowDirty,
        ...(options.maxCost === undefined ? {} : { maxCost: options.maxCost }),
        yesVerify: options.yesVerify,
        json: options.json,
        taskId: task.id,
        ...(options.quiet === undefined ? {} : { quiet: options.quiet }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      result = {
        status: TEAM_STATUS[outcome.status],
        exitCode: teamExitCode(outcome.status),
        runId: outcome.runId,
        ...(outcome.code === undefined ? {} : { code: outcome.code }),
        ...(outcome.message === undefined ? {} : { message: outcome.message }),
      };
    } else {
      const run = await executeRun(context, workspace, { input: task.goal, role: "researcher", json: options.json, taskId: task.id });
      result = {
        status: runStatus(run.outcome),
        exitCode: runExitCode(run.outcome),
        runId: run.sessionId,
        ...(run.outcome.type === "failed" ? { code: run.outcome.code, message: run.outcome.message } : {}),
      };
    }
  } catch (error) {
    const refused = error instanceof CliError && error.exitCode === EXIT_BUDGET;
    await store.setStatus({ id: task.id, status: refused ? "open" : "failed", code: refused ? "budget" : "error", message: errorMessage(error) });
    throw error;
  }
  await store.setStatus({
    id: task.id,
    status: result.status,
    runId: result.runId,
    ...(result.code === undefined ? {} : { code: result.code }),
    ...(result.message === undefined ? {} : { message: result.message }),
  });
  if (options.json) {
    new JsonlWriter(context.io.stdout, context.redactor).writeResult("task-run", { taskId: task.id, status: result.status, runId: result.runId });
  } else {
    context.err.line(`bma: task ${task.id}: ${result.status} (run ${result.runId})`);
  }
  return result;
}

async function runSequential(
  context: CommandContext,
  workspace: Workspace,
  store: TaskStore,
  options: TaskRunOptions,
  reference: string | undefined,
  all: boolean,
): Promise<RunSummary> {
  let exitCode: number | undefined;
  let executed = 0;
  for (;;) {
    const task = pickTask(await store.load(), executed === 0 ? reference : undefined);
    if (task === undefined) {
      break;
    }
    executed += 1;
    const result = await executeTask(context, workspace, store, task, options);
    if (result.status !== "done") {
      exitCode ??= result.exitCode;
    }
    if (result.status === "open" || !all) {
      break;
    }
  }
  return { executed, ...(exitCode === undefined ? {} : { exitCode }) };
}

async function runParallel(context: CommandContext, workspace: Workspace, store: TaskStore, options: TaskRunOptions, limit: number): Promise<RunSummary> {
  const controller = new AbortController();
  const uninstall = installRunInterrupt(context, controller);
  const running = new Map<string, { readonly mode: TaskState["mode"]; readonly done: Promise<Settled> }>();
  const teamOptions: TaskRunOptions = { ...options, quiet: true, signal: controller.signal };
  let executed = 0;
  let exitCode: number | undefined;
  let stopping = false;
  let failure: { readonly error: unknown } | undefined;
  const start = (task: TaskState): void => {
    executed += 1;
    const done = executeTask(context, workspace, store, task, task.mode === "team" ? teamOptions : options).then(
      (result): Settled => ({ id: task.id, result }),
      (error: unknown): Settled => ({ id: task.id, error }),
    );
    running.set(task.id, { mode: task.mode, done });
  };
  try {
    for (;;) {
      if (!stopping && !controller.signal.aborted && ![...running.values()].some((entry) => entry.mode === "ask")) {
        const tasks = await store.load();
        for (const task of tasks.filter((candidate) => isReady(candidate, tasks) && !running.has(candidate.id))) {
          if (running.size >= limit || (task.mode === "ask" && running.size > 0)) {
            break;
          }
          start(task);
          if (task.mode === "ask") {
            break;
          }
        }
      }
      if (running.size === 0) {
        break;
      }
      const settled = await Promise.race([...running.values()].map((entry) => entry.done));
      running.delete(settled.id);
      if ("error" in settled) {
        failure ??= { error: settled.error };
        stopping = true;
        continue;
      }
      if (settled.result.status !== "done") {
        exitCode ??= settled.result.exitCode;
      }
      if (settled.result.status === "open") {
        stopping = true;
      }
    }
  } finally {
    uninstall();
  }
  if (failure !== undefined) {
    throw failure.error;
  }
  return { executed, ...(exitCode === undefined ? {} : { exitCode }) };
}

async function runTasks(context: CommandContext, args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      all: { type: "boolean", default: false },
      "allow-dirty": { type: "boolean", default: false },
      "max-cost": { type: "string" },
      "yes-verify": { type: "boolean", default: false },
      parallel: { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  const [reference, ...extra] = positionals;
  if (extra.length > 0) {
    throw usageError("usage: bma task run [<id>] [--all [--parallel <n>]]");
  }
  if (reference !== undefined && values.all) {
    throw usageError("give either a task id or --all, not both");
  }
  const parallel = parseParallel(values.parallel);
  if (parallel > 1 && !values.all) {
    throw usageError("--parallel needs --all");
  }
  const maxCost = parseCost(values["max-cost"]);
  const { workspace, store } = await openStore(context);
  reportWorkspace(context, workspace);
  const options: TaskRunOptions = {
    allowDirty: values["allow-dirty"],
    ...(maxCost === undefined ? {} : { maxCost }),
    yesVerify: values["yes-verify"],
    json: values.json,
  };
  const lock = await lockRunner(context, store);
  let summary: RunSummary;
  try {
    await resetInterrupted(store);
    summary = parallel > 1 ? await runParallel(context, workspace, store, options, parallel) : await runSequential(context, workspace, store, options, reference, values.all);
  } finally {
    await lock.release();
  }
  if (summary.executed === 0) {
    if (values.json) {
      new JsonlWriter(context.io.stdout, context.redactor).writeResult("task-run", { taskId: null, status: "idle" });
    } else {
      context.err.line("bma: no ready task");
    }
  }
  return summary.exitCode ?? EXIT_OK;
}

export async function taskCommand(context: CommandContext, args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub?.startsWith("-") === true) {
    return listTasks(context, args);
  }
  switch (sub) {
    case "add":
      return addTask(context, rest);
    case "list":
    case undefined:
      return listTasks(context, rest);
    case "show":
      return showTask(context, rest);
    case "cancel":
      return cancelTask(context, rest);
    case "run":
      return runTasks(context, rest);
    default:
      throw usageError(`unknown task command ${JSON.stringify(sub)}; expected add, list, show, run or cancel`);
  }
}
