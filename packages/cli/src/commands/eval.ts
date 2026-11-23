import { TEAM_ROLES } from "@betamultiagent/core";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { EXIT_FAILED, EXIT_OK, usageError } from "../cli-error.js";
import { estimateSuite, providerRoles, type EvalProvider, type SuiteEstimate } from "../eval/eval-estimate.js";
import { summarize, type EvalSummary, type RateMetric } from "../eval/eval-metrics.js";
import { runEvalTask, type EvalRunRecord, type MainEntry } from "../eval/eval-runner.js";
import { loadEvalSuite, selectTasks } from "../eval/eval-suite.js";
import type { TerminalWriter } from "../output/human.js";
import { JsonlWriter } from "../output/jsonl.js";
import { catalogModel } from "../wiring.js";
import type { CommandContext } from "./command-context.js";

export const EVAL_USAGE =
  "usage: bma eval <suite-dir> --provider claude|grok (--estimate | --max-cost <usd>) [--task <id>]... [--repeat <n>] [--max-wall-minutes <n>] [--out <file>] [--keep] [--json]";

const DEFAULT_WALL_MINUTES = 20;

function positiveNumber(flag: string, text: string | undefined): number | undefined {
  if (text === undefined) {
    return undefined;
  }
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) {
    throw usageError(`${flag} must be a positive number, got ${JSON.stringify(text)}`);
  }
  return value;
}

function positiveInteger(flag: string, text: string | undefined, fallback: number): number {
  const value = positiveNumber(flag, text) ?? fallback;
  if (!Number.isInteger(value)) {
    throw usageError(`${flag} must be a positive integer, got ${JSON.stringify(text)}`);
  }
  return value;
}

function parseProvider(text: string | undefined): EvalProvider {
  if (text !== "claude" && text !== "grok") {
    throw usageError(`--provider must be claude or grok; ${EVAL_USAGE}`);
  }
  return text;
}

function usd(value: number): string {
  return `$${value.toFixed(4)}`;
}

function percent(metric: RateMetric): string {
  return metric.rate === null ? "n/a" : `${String(metric.count)}/${String(metric.runs)} (${(metric.rate * 100).toFixed(0)}%)`;
}

function printEstimate(out: TerminalWriter, estimate: SuiteEstimate): void {
  out.line(`estimate for ${estimate.provider}, ${String(estimate.runs)} run(s):`);
  for (const task of estimate.tasks) {
    const roles = TEAM_ROLES.flatMap((role) => {
      const entry = task.roles[role];
      return entry === undefined || entry.turns === 0 ? [] : [`${role} ${entry.model} x${String(entry.turns)} ${usd(entry.costUsd)}`];
    });
    out.line(`  ${task.taskId}: ${usd(task.costUsd)} (${roles.join(", ")})`);
  }
  out.line(`expected: ${usd(estimate.expectedUsd)}${estimate.capUsd === undefined ? "" : `, hard cap: ${usd(estimate.capUsd)}`}`);
  if (estimate.unpriced.length > 0) {
    out.line(`no price data for: ${estimate.unpriced.join(", ")}`);
  }
}

function printSummary(out: TerminalWriter, summary: EvalSummary): void {
  out.line(`runs: ${String(summary.runs)}, harness errors: ${String(summary.errors)}`);
  out.line(`normal tasks approved: ${percent(summary.normalApproved)}, correct: ${percent(summary.normalCorrect)}`);
  out.line(`hard-to-verify approved: ${percent(summary.hardToVerifyApproved)}`);
  out.line(`trap tasks falsely approved: ${percent(summary.trapFalseApproved)}`);
  out.line(`approved runs failing the hidden check: ${percent(summary.approvedCheckFailed)}`);
  out.line(
    `revisions: ${String(summary.revisions.total)}, plan corrections: ${String(summary.planCorrections)}, invalid tool inputs: ${String(summary.invalidInputs)}`,
  );
  const roles = TEAM_ROLES.flatMap((role) => {
    const cost = summary.costByRole[role];
    return cost === undefined ? [] : [`${role} ${usd(cost)}`];
  });
  out.line(`cost: ${usd(summary.costUsd)}${roles.length === 0 ? "" : ` (${roles.join(", ")})`}`);
  out.line(`statuses: ${JSON.stringify(summary.statuses)}${Object.keys(summary.codes).length === 0 ? "" : `, codes: ${JSON.stringify(summary.codes)}`}`);
}

function describeRun(record: EvalRunRecord): string {
  const check = record.checkPassed === undefined ? "" : `, check ${record.checkPassed ? "passed" : "failed"}`;
  const code = record.code === undefined ? "" : ` (${record.code})`;
  return `${record.taskId}#${String(record.attempt)}: ${record.status}${code}${check}, ${record.correct ? "as expected" : "NOT as expected"}, ${usd(record.costUsd)}`;
}

function defaultOutFile(suiteDir: string, provider: EvalProvider, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/gu, "-").replace("T", "_").slice(0, 19);
  return path.join(suiteDir, "results", `${stamp}-${provider}.json`);
}

export async function evalCommand(context: CommandContext, args: readonly string[], main: MainEntry): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      provider: { type: "string" },
      task: { type: "string", multiple: true, default: [] },
      repeat: { type: "string" },
      "max-cost": { type: "string" },
      "max-wall-minutes": { type: "string" },
      estimate: { type: "boolean", default: false },
      out: { type: "string" },
      keep: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  });
  const [suiteArg, ...extra] = positionals;
  if (suiteArg === undefined || extra.length > 0) {
    throw usageError(EVAL_USAGE);
  }
  const provider = parseProvider(values.provider);
  const repeat = positiveInteger("--repeat", values.repeat, 1);
  const maxCostUsd = positiveNumber("--max-cost", values["max-cost"]);
  const maxWallMinutes = positiveInteger("--max-wall-minutes", values["max-wall-minutes"], DEFAULT_WALL_MINUTES);
  const suite = await loadEvalSuite(path.resolve(context.io.cwd, suiteArg));
  const tasks = selectTasks(suite, values.task);
  const estimate = estimateSuite(provider, tasks, repeat, maxCostUsd, (role, roles) => catalogModel(roles[role].model).pricing ?? []);
  const jsonl = values.json ? new JsonlWriter(context.io.stdout, context.redactor) : undefined;
  if (values.estimate) {
    if (jsonl === undefined) {
      printEstimate(context.out, estimate);
    } else {
      jsonl.writeResult("eval-estimate", { estimate });
    }
    return EXIT_OK;
  }
  if (maxCostUsd === undefined) {
    throw usageError(`--max-cost is required to run an eval; ${EVAL_USAGE}`);
  }
  if (jsonl === undefined) {
    printEstimate(context.err, estimate);
  }
  const startedAt = context.io.now();
  const records: EvalRunRecord[] = [];
  const total = tasks.length * repeat;
  for (let attempt = 1; attempt <= repeat; attempt += 1) {
    for (const task of tasks) {
      const record = await runEvalTask({
        suite,
        task,
        attempt,
        provider,
        maxCostUsd,
        maxWallMinutes,
        io: context.io,
        overrides: context.overrides,
        main,
        keep: values.keep,
      });
      records.push(record);
      context.err.line(`bma: [${String(records.length)}/${String(total)}] ${describeRun(record)}`);
      if (record.status === "error" && record.message !== undefined) {
        context.err.line(`  ${record.message.split("\n").slice(-5).join("\n  ")}`);
      }
    }
  }
  const summary = summarize(records);
  const roles = providerRoles(provider);
  const report = {
    version: 1,
    startedAt: startedAt.toISOString(),
    finishedAt: context.io.now().toISOString(),
    provider,
    roles: Object.fromEntries(TEAM_ROLES.map((role) => [role, `${roles[role].model.provider}:${roles[role].model.id}`])),
    suite: suite.dir,
    tasks: tasks.map((task) => task.id),
    repeat,
    maxCostUsd,
    maxWallMinutes,
    estimate,
    summary,
    records,
  };
  const outFile = values.out === undefined ? defaultOutFile(suite.dir, provider, startedAt) : path.resolve(context.io.cwd, values.out);
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, `${JSON.stringify(context.redactor.redactValue(report), null, 2)}\n`);
  if (jsonl === undefined) {
    printSummary(context.out, summary);
    context.err.line(`bma: results written to ${outFile}`);
  } else {
    jsonl.writeResult("eval-result", { file: outFile, summary });
  }
  return summary.errors > 0 ? EXIT_FAILED : EXIT_OK;
}
