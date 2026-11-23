import { ulid } from "@betamultiagent/core";
import { parseArgs } from "node:util";
import { readAuditLedger } from "../audit/audit-ledger.js";
import { openDailySpend } from "../budget/run-budget.js";
import { CliError, EXIT_BUDGET, EXIT_FAILED, EXIT_OK, usageError } from "../cli-error.js";
import { auditDir, tasksDir } from "../config/paths.js";
import { parseModelSpec } from "../config/schema.js";
import { MemoryLimitError, type MemoryEntry } from "../memory/memory-store.js";
import { requestToolCall } from "../model/single-tool-call.js";
import { JsonlWriter } from "../output/jsonl.js";
import { displayValue } from "../output/sanitize.js";
import { buildDigest, PROPOSE_IMPROVEMENTS, REFLECT_MAX_OUTPUT_TOKENS, REFLECT_SYSTEM, ReflectionSchema, reflectPrompt } from "../reflect/reflection.js";
import { TaskStore } from "../tasks/task-store.js";
import { createModelResolver, openMemoryStore, openWorkspace, teamRoles } from "../wiring.js";
import type { CommandContext } from "./command-context.js";

const DEFAULT_DAYS = 7;
const MAX_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
export const REFLECT_AGENT = "reflect";

function parseDays(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_DAYS;
  }
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
    throw usageError(`--days must be an integer from 1 to ${String(MAX_DAYS)}`);
  }
  return days;
}

export async function reflectCommand(context: CommandContext, args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: { days: { type: "string" }, model: { type: "string", short: "m" }, json: { type: "boolean", default: false } },
  });
  if (positionals.length > 0) {
    throw usageError("bma reflect takes no positional arguments");
  }
  const days = parseDays(values.days);
  const modelRef = values.model === undefined ? undefined : parseModelSpec(values.model);
  const workspace = await openWorkspace(context.io, context.redactor);
  const warn = (scope: string) => (message: string) => {
    context.err.line(`bma: ${scope}: ${message}`);
  };
  const now = context.io.now();
  const memory = openMemoryStore(workspace, warn("memory"));
  const digest = buildDigest({
    records: await readAuditLedger(auditDir(workspace.dirs, workspace.root), warn("audit")),
    tasks: await new TaskStore(tasksDir(workspace.dirs, workspace.root), context.redactor, context.io.now, warn("tasks")).load(),
    memory: await memory.load(),
    since: new Date(now.getTime() - days * DAY_MS),
  });
  if (digest.runs === 0 && digest.tasks === 0) {
    context.err.line(`bma: no runs or open problems in the last ${String(days)} days; nothing to reflect on`);
    if (values.json) {
      new JsonlWriter(context.io.stdout, context.redactor).writeResult("reflect", { runs: 0, tasks: 0, costUsd: 0, memory: [], skills: [] });
    }
    return EXIT_OK;
  }
  const daily = openDailySpend(context, workspace);
  if (daily !== undefined && !(await daily.hasRemaining())) {
    throw new CliError(EXIT_BUDGET, `the daily cost cap of $${daily.limitUsd.toFixed(4)} is reached`);
  }
  const target = createModelResolver(context.io.env, context.overrides)(modelRef ?? teamRoles(workspace, context.overrides).reviewer.model);
  const controller = new AbortController();
  let result;
  try {
    result = await requestToolCall(
      target,
      {
        system: REFLECT_SYSTEM,
        prompt: reflectPrompt(digest),
        toolName: PROPOSE_IMPROVEMENTS,
        toolDescription: "Record the reflection on the recent runs.",
        schema: ReflectionSchema,
        maxOutputTokens: REFLECT_MAX_OUTPUT_TOKENS,
        cacheKey: "bma-reflect",
      },
      controller.signal,
    );
  } finally {
    controller.abort();
  }
  await daily?.charge(result.costUsd);
  if (!result.ok) {
    throw new CliError(EXIT_FAILED, `the reflection failed: ${result.problem} (cost $${result.costUsd.toFixed(4)})`);
  }
  const reflection = result.value;
  const sessionId = ulid(now.getTime());
  const stored: MemoryEntry[] = [];
  for (const item of reflection.memory) {
    try {
      stored.push(await memory.propose({ text: item.text, reason: item.evidence, source: { agent: REFLECT_AGENT, sessionId } }));
    } catch (error) {
      if (!(error instanceof MemoryLimitError)) {
        throw error;
      }
      context.err.line(`bma: memory proposal not recorded: ${error.message}`);
      break;
    }
  }
  context.err.line(`bma: reflected on ${String(digest.runs)} runs and ${String(digest.tasks)} tasks from the last ${String(days)} days, cost $${result.costUsd.toFixed(4)}`);
  if (values.json) {
    new JsonlWriter(context.io.stdout, context.redactor).writeResult("reflect", {
      runs: digest.runs,
      tasks: digest.tasks,
      costUsd: result.costUsd,
      summary: reflection.summary,
      memory: stored.map((entry) => ({ id: entry.id, text: entry.text, reason: entry.reason })),
      skills: reflection.skills,
    });
    return EXIT_OK;
  }
  const out = context.out;
  out.line(displayValue(reflection.summary, 2000));
  if (stored.length > 0) {
    out.line("");
    out.line("memory proposals (pending):");
    for (const entry of stored) {
      out.line(`  ${entry.id}  ${displayValue(entry.text, 500)}`);
      out.line(`    evidence: ${displayValue(entry.reason ?? "", 500)}`);
    }
    out.line("approve with `bma memory approve <id>` or reject with `bma memory reject <id>`");
  }
  if (reflection.skills.length > 0) {
    out.line("");
    out.line("skill suggestions (not applied):");
    for (const suggestion of reflection.skills) {
      out.line(`  ${displayValue(suggestion.skill)}: ${displayValue(suggestion.change, 2000)}`);
      out.line(`    evidence: ${displayValue(suggestion.evidence, 500)}`);
    }
    out.line("to apply one, edit the skill and keep the change only if `bma eval --variant` does not score worse than the current skills");
  }
  if (stored.length === 0 && reflection.skills.length === 0) {
    out.line("no proposals");
  }
  return EXIT_OK;
}
