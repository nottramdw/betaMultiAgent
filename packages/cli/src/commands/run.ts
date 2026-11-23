import {
  AgentRoleSchema,
  AgentSession,
  buildSystemPrompt,
  DEFAULT_MAX_TURNS,
  loadProjectContext,
  SessionStore,
  ulid,
  type AgentRole,
  type AgentSpec,
  type EventListener,
  type ModelRef,
  type TurnOutcome,
} from "@betamultiagent/core";
import path from "node:path";
import { parseArgs } from "node:util";
import { createTtyApprover } from "../approver/tty-approver.js";
import { openAudit } from "../audit/open-audit.js";
import { reserveRunBudget, trackSpend } from "../budget/run-budget.js";
import { EXIT_BUDGET, EXIT_FAILED, EXIT_INTERRUPTED, EXIT_OK, EXIT_STOPPED, usageError } from "../cli-error.js";
import { sessionsDir } from "../config/paths.js";
import { parseModelSpec } from "../config/schema.js";
import { readPromptFile, readStream } from "../input/prompt-file.js";
import { HumanRenderer } from "../output/human.js";
import { JsonlWriter } from "../output/jsonl.js";
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
  wallMs,
  type Workspace,
} from "../wiring.js";
import { isInteractive, openPromptChannel, type CommandContext, type OpenedChannel } from "./command-context.js";
import { reportWorkspace } from "./team.js";

const WRITE_INSTRUCTIONS = [
  "Complete the user's task in the workspace.",
  "Read the relevant files before editing, keep changes minimal and focused, and run relevant checks when they help.",
  "Finish with a short summary of what changed and what was verified.",
].join("\n");

const READ_ONLY_INSTRUCTIONS = [
  "Answer the user's request using the read-only tools. You cannot change files or run commands.",
  "Finish with a concise, accurate answer that cites the files you relied on.",
].join("\n");

function withExtra(base: string, extra: string | undefined): string {
  return extra === undefined ? base : `${base}\n\n${extra.trim()}`;
}

export function runExitCode(outcome: TurnOutcome): number {
  switch (outcome.type) {
    case "completed":
      return EXIT_OK;
    case "refused":
      return EXIT_STOPPED;
    case "budget-exceeded":
      return EXIT_BUDGET;
    case "aborted":
      return EXIT_INTERRUPTED;
    case "loop-detected":
    case "max-tokens":
    case "failed":
      return EXIT_FAILED;
  }
}

function describeOutcome(outcome: TurnOutcome): string | undefined {
  switch (outcome.type) {
    case "completed":
      return undefined;
    case "refused":
      return "the model refused the request";
    case "budget-exceeded":
      return `stopped: ${outcome.budget} budget exceeded`;
    case "loop-detected":
      return `stopped: repeated identical calls to ${outcome.tool}`;
    case "max-tokens":
      return "stopped: the response hit the output token limit";
    case "aborted":
      return "interrupted";
    case "failed":
      return `failed (${outcome.code}): ${outcome.message}`;
  }
}

async function readInput(context: CommandContext, values: { prompt?: string; "prompt-file"?: string }, positionals: readonly string[]): Promise<string> {
  const sources = [values.prompt !== undefined, values["prompt-file"] !== undefined, positionals.length > 0].filter(Boolean).length;
  if (sources > 1) {
    throw usageError("give the prompt only once: --prompt, --prompt-file or a positional argument");
  }
  let text: string;
  if (values.prompt !== undefined) {
    text = values.prompt;
  } else if (values["prompt-file"] !== undefined) {
    text = await readPromptFile(path.resolve(context.io.cwd, values["prompt-file"]));
  } else if (positionals.length > 0) {
    text = positionals.join(" ");
  } else if (!context.io.stdinIsTTY) {
    text = await readStream(context.io.stdin, "standard input");
  } else {
    throw usageError("missing prompt; use --prompt, --prompt-file or pipe the prompt on standard input");
  }
  if (text.trim().length === 0) {
    throw usageError("the prompt is empty");
  }
  return text;
}

function chooseModel(workspace: Workspace, context: CommandContext, role: AgentRole, flag: string | undefined): ModelRef {
  if (flag !== undefined) {
    return parseModelSpec(flag);
  }
  return teamRoles(workspace, context.overrides)[role].model;
}

export async function runCommand(context: CommandContext, args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      prompt: { type: "string", short: "p" },
      "prompt-file": { type: "string", short: "f" },
      model: { type: "string", short: "m" },
      role: { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  const role = AgentRoleSchema.safeParse(values.role ?? "executor");
  if (!role.success) {
    throw usageError(`invalid role ${JSON.stringify(values.role)}; expected lead, executor, reviewer or researcher`);
  }
  const input = await readInput(context, values, positionals);
  const workspace = await openWorkspace(context.io, context.redactor);
  reportWorkspace(context, workspace);
  const result = await executeRun(context, workspace, {
    input,
    role: role.data,
    ...(values.model === undefined ? {} : { model: values.model }),
    json: values.json,
  });
  return runExitCode(result.outcome);
}

export interface RunExecution {
  readonly input: string;
  readonly role: AgentRole;
  readonly model?: string;
  readonly json: boolean;
  readonly taskId?: string;
}

export interface RunResult {
  readonly sessionId: string;
  readonly outcome: TurnOutcome;
}

export async function executeRun(context: CommandContext, workspace: Workspace, execution: RunExecution): Promise<RunResult> {
  const { input, role } = execution;
  const modelRef = chooseModel(workspace, context, role, execution.model);
  const { provider, model } = createModelResolver(context.io.env, context.overrides)(modelRef);
  const skills = await loadSkills(workspace);
  for (const warning of skills.warnings) {
    context.err.line(`bma: skills: ${warning}`);
  }
  await ensureStateDir(workspace.dirs);
  const environment = createEnvironment(workspace, skills, workspace.root, "local");
  const writable = role === "executor";
  const tools = createTools(environment, skills).filter((tool) => writable || tool.capabilities.readOnly);
  const name = role;
  const opened: OpenedChannel | undefined = isInteractive(context, execution.json) ? openPromptChannel(context) : undefined;
  const permissions = createPermissionEngine(workspace, environment, skills, opened === undefined ? undefined : createTtyApprover(opened.channel, name));
  const roleConfig = workspace.config.roles[role];
  const maxWallMs = wallMs(workspace.config.budget);
  const runBudget = await reserveRunBudget(context, workspace, workspace.config.budget.maxCostUsd);
  const spec: AgentSpec = {
    name,
    role: role,
    instructions: withExtra(writable ? WRITE_INSTRUCTIONS : READ_ONLY_INSTRUCTIONS, roleConfig?.instructions),
    model: modelRef,
    tools: tools.map((tool) => tool.name),
    permissions: { rules: [...workspace.config.rules], extraReadRoots: [...skills.readRoots()] },
    budget: {
      maxTurns: roleConfig?.maxTurns ?? DEFAULT_MAX_TURNS[role],
      ...(runBudget.maxCostUsd === undefined ? {} : { maxCostUsd: runBudget.maxCostUsd }),
      ...(maxWallMs === undefined ? {} : { maxWallMs }),
    },
  };
  const createdAt = context.io.now();
  const id = ulid(createdAt.getTime());
  const catalog = skillCatalog(skills);
  const projectContext = await loadProjectContext({
    root: workspace.root,
    trusted: workspace.trusted,
    ...(catalog === undefined ? {} : { skillCatalog: catalog }),
  });
  const store = await SessionStore.open({ dir: path.join(sessionsDir(workspace.dirs, workspace.root), id), redactor: context.redactor });
  const human = execution.json ? undefined : new HumanRenderer({ stdout: context.out, stderr: context.err, streamText: true });
  const listener: EventListener = human ?? new JsonlWriter(context.io.stdout, context.redactor);
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
  const audit = await openAudit(context, workspace, id);
  audit.recorder.start({
    command: "run",
    roles: { [role]: modelRef },
    budget: {
      ...(spec.budget.maxCostUsd === undefined ? {} : { maxCostUsd: spec.budget.maxCostUsd }),
      ...(spec.budget.maxWallMs === undefined ? {} : { maxWallMs: spec.budget.maxWallMs }),
    },
    task: input,
    ...(execution.taskId === undefined ? {} : { taskId: execution.taskId }),
  });
  let outcome: TurnOutcome | undefined;
  let session: AgentSession | undefined;
  try {
    session = new AgentSession({
      id,
      spec,
      provider,
      model,
      tools,
      environment,
      permissions,
      redactor: context.redactor,
      events: trackSpend(audit.recorder.tap(store, id, role), runBudget.reservation),
      systemPrompt: buildSystemPrompt({
        agentName: name,
        role: role,
        instructions: spec.instructions,
        platform: context.io.platform,
        root: workspace.root,
        createdAt,
      }),
      ...(projectContext === undefined ? {} : { projectContext }),
      originalInput: input,
    });
    outcome = await session.run(input, { signal: controller.signal, listeners: [listener] });
  } finally {
    uninstall();
    opened?.close();
    await store.close();
    if (outcome !== undefined && session !== undefined) {
      audit.recorder.runOutcome(outcome, role, session.ledger.snapshot());
    }
    await audit.ledger.close();
    await runBudget.reservation?.release();
  }
  if (human !== undefined) {
    human.flush();
    if (outcome.type === "completed" && !human.wroteText && outcome.text.trim().length > 0) {
      context.out.line(outcome.text);
    }
    const problem = describeOutcome(outcome);
    if (problem !== undefined) {
      context.err.line(`bma: ${problem}`);
    }
    context.err.line(`bma: session ${id}, cost $${human.costUsd.toFixed(4)}`);
  }
  return { sessionId: id, outcome };
}
