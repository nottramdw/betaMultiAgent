import type { AgentRole } from "@betamultiagent/core";
import type { EvalRunRecord } from "./eval-runner.js";

export interface RateMetric {
  readonly runs: number;
  readonly count: number;
  readonly rate: number | null;
}

export interface EvalSummary {
  readonly runs: number;
  readonly errors: number;
  readonly normalApproved: RateMetric;
  readonly normalCorrect: RateMetric;
  readonly hardToVerifyApproved: RateMetric;
  readonly trapFalseApproved: RateMetric;
  readonly approvedCheckFailed: RateMetric;
  readonly revisions: { readonly total: number; readonly mean: number | null };
  readonly planCorrections: number;
  readonly invalidInputs: number;
  readonly costUsd: number;
  readonly costByRole: Partial<Record<AgentRole, number>>;
  readonly statuses: Readonly<Record<string, number>>;
  readonly codes: Readonly<Record<string, number>>;
}

function rate(records: readonly EvalRunRecord[], hit: (record: EvalRunRecord) => boolean): RateMetric {
  const count = records.filter(hit).length;
  return { runs: records.length, count, rate: records.length === 0 ? null : count / records.length };
}

function tally(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

export function summarize(records: readonly EvalRunRecord[]): EvalSummary {
  const completed = records.filter((record) => record.status !== "error");
  const normal = completed.filter((record) => record.kind === "normal");
  const costByRole: Partial<Record<AgentRole, number>> = {};
  for (const record of records) {
    for (const [role, cost] of Object.entries(record.costByRole) as [AgentRole, number][]) {
      costByRole[role] = (costByRole[role] ?? 0) + cost;
    }
  }
  const revisions = completed.reduce((sum, record) => sum + record.revisions, 0);
  return {
    runs: records.length,
    errors: records.length - completed.length,
    normalApproved: rate(normal, (record) => record.approved),
    normalCorrect: rate(normal, (record) => record.correct),
    hardToVerifyApproved: rate(
      completed.filter((record) => record.kind === "hard-to-verify"),
      (record) => record.approved,
    ),
    trapFalseApproved: rate(
      completed.filter((record) => record.kind === "trap"),
      (record) => record.approved,
    ),
    approvedCheckFailed: rate(
      completed.filter((record) => record.approved && record.checkPassed !== undefined),
      (record) => record.checkPassed === false,
    ),
    revisions: { total: revisions, mean: completed.length === 0 ? null : revisions / completed.length },
    planCorrections: completed.reduce((sum, record) => sum + record.planCorrections, 0),
    invalidInputs: completed.reduce((sum, record) => sum + record.invalidInputs, 0),
    costUsd: records.reduce((sum, record) => sum + record.costUsd, 0),
    costByRole,
    statuses: tally(records.map((record) => record.status)),
    codes: tally(records.flatMap((record) => (record.code === undefined ? [] : [record.code]))),
  };
}
