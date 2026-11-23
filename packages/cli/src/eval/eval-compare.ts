import { TEAM_ROLES } from "@betamultiagent/core";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { usageError } from "../cli-error.js";

const RateSchema = z.object({ runs: z.number(), count: z.number(), rate: z.number().nullable() });

const ReportSchema = z.object({
  version: z.literal(1),
  provider: z.string(),
  suite: z.string(),
  tasks: z.array(z.string()),
  repeat: z.number(),
  variant: z.object({ name: z.string(), sha256: z.string() }).optional(),
  summary: z.object({
    runs: z.number(),
    errors: z.number(),
    normalApproved: RateSchema,
    normalCorrect: RateSchema,
    hardToVerifyApproved: RateSchema,
    trapFalseApproved: RateSchema,
    approvedCheckFailed: RateSchema,
    revisions: z.object({ total: z.number(), mean: z.number().nullable() }),
    costUsd: z.number(),
    costByRole: z.record(z.string(), z.number()),
  }),
  records: z.array(z.object({ taskId: z.string(), correct: z.boolean() })),
});
export type EvalReport = z.infer<typeof ReportSchema>;
type Rate = z.infer<typeof RateSchema>;

export interface LoadedReport {
  readonly file: string;
  readonly label: string;
  readonly report: EvalReport;
}

export type MetricUnit = "rate" | "count" | "usd";

export interface MetricValue {
  readonly value: number | null;
  readonly count?: number;
  readonly runs?: number;
}

export interface MetricDelta {
  readonly name: string;
  readonly unit: MetricUnit;
  readonly a: MetricValue;
  readonly b: MetricValue;
  readonly delta: number | null;
}

export interface TaskTally {
  readonly correct: number;
  readonly runs: number;
}

export interface TaskDelta {
  readonly taskId: string;
  readonly a: TaskTally | null;
  readonly b: TaskTally | null;
  readonly changed: boolean;
}

export interface EvalComparison {
  readonly a: { readonly file: string; readonly label: string };
  readonly b: { readonly file: string; readonly label: string };
  readonly metrics: readonly MetricDelta[];
  readonly tasks: readonly TaskDelta[];
  readonly warnings: readonly string[];
}

export async function loadReport(file: string): Promise<LoadedReport> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw usageError(`cannot read eval report ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = ReportSchema.safeParse(raw);
  if (!parsed.success) {
    throw usageError(`${file}: not an eval report (${parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")})`);
  }
  const report = parsed.data;
  return { file, label: report.variant === undefined ? report.provider : `${report.provider}/${report.variant.name}`, report };
}

function rateValue(rate: Rate): MetricValue {
  return { value: rate.rate, count: rate.count, runs: rate.runs };
}

function plain(value: number | null): MetricValue {
  return { value };
}

function metric(name: string, unit: MetricUnit, a: MetricValue, b: MetricValue): MetricDelta {
  return { name, unit, a, b, delta: a.value === null || b.value === null ? null : b.value - a.value };
}

function tallies(report: EvalReport): Map<string, TaskTally> {
  const result = new Map<string, TaskTally>();
  for (const record of report.records) {
    const current = result.get(record.taskId) ?? { correct: 0, runs: 0 };
    result.set(record.taskId, { correct: current.correct + (record.correct ? 1 : 0), runs: current.runs + 1 });
  }
  return result;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item) => b.includes(item));
}

export function compareReports(left: LoadedReport, right: LoadedReport): EvalComparison {
  const a = left.report;
  const b = right.report;
  const perRun = (report: EvalReport): number | null => (report.summary.runs === 0 ? null : report.summary.costUsd / report.summary.runs);
  const metrics: MetricDelta[] = [
    metric("normal tasks correct", "rate", rateValue(a.summary.normalCorrect), rateValue(b.summary.normalCorrect)),
    metric("normal tasks approved", "rate", rateValue(a.summary.normalApproved), rateValue(b.summary.normalApproved)),
    metric("hard-to-verify approved", "rate", rateValue(a.summary.hardToVerifyApproved), rateValue(b.summary.hardToVerifyApproved)),
    metric("trap tasks falsely approved", "rate", rateValue(a.summary.trapFalseApproved), rateValue(b.summary.trapFalseApproved)),
    metric("approved runs failing the hidden check", "rate", rateValue(a.summary.approvedCheckFailed), rateValue(b.summary.approvedCheckFailed)),
    metric("revisions per run", "count", plain(a.summary.revisions.mean), plain(b.summary.revisions.mean)),
    metric("harness errors", "count", plain(a.summary.errors), plain(b.summary.errors)),
    metric("cost", "usd", plain(a.summary.costUsd), plain(b.summary.costUsd)),
    metric("cost per run", "usd", plain(perRun(a)), plain(perRun(b))),
    ...TEAM_ROLES.flatMap((role) => {
      const costA = a.summary.costByRole[role];
      const costB = b.summary.costByRole[role];
      return costA === undefined && costB === undefined ? [] : [metric(`cost ${role}`, "usd", plain(costA ?? 0), plain(costB ?? 0))];
    }),
  ];
  const tallyA = tallies(a);
  const tallyB = tallies(b);
  const ids = [...new Set([...a.tasks, ...b.tasks, ...tallyA.keys(), ...tallyB.keys()])];
  const tasks = ids.map((taskId): TaskDelta => {
    const ta = tallyA.get(taskId) ?? null;
    const tb = tallyB.get(taskId) ?? null;
    const changed = ta === null || tb === null || ta.correct * tb.runs !== tb.correct * ta.runs;
    return { taskId, a: ta, b: tb, changed };
  });
  const warnings = [
    ...(a.suite === b.suite ? [] : [`the reports use different suites (${a.suite}, ${b.suite})`]),
    ...(sameSet(a.tasks, b.tasks) ? [] : ["the reports cover different task sets"]),
    ...(a.repeat === b.repeat ? [] : [`the reports use different repeat counts (${String(a.repeat)}, ${String(b.repeat)})`]),
  ];
  return { a: { file: left.file, label: left.label }, b: { file: right.file, label: right.label }, metrics, tasks, warnings };
}
