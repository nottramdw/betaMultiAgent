import type { AgentRole } from "@betamultiagent/core";
import type { JudgeRecord } from "./eval-judge.js";
import type { EvalRunRecord } from "./eval-runner.js";

export interface RateMetric {
  readonly runs: number;
  readonly count: number;
  readonly rate: number | null;
}

export interface JudgeSummary {
  readonly model: string;
  readonly graded: number;
  readonly errors: number;
  readonly skipped: number;
  readonly passed: RateMetric;
  readonly accuracy: RateMetric;
  readonly reviewerAgreement: RateMetric;
  readonly costUsd: number;
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
  readonly judges: readonly JudgeSummary[];
  readonly judgeAgreement: RateMetric | null;
  readonly judgeCostUsd: number;
}

function rate<T>(records: readonly T[], hit: (record: T) => boolean): RateMetric {
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

export function judgeReference(record: EvalRunRecord): boolean | undefined {
  if (record.checkPassed !== undefined) {
    return record.checkPassed;
  }
  return record.expect === "not-approved" ? false : undefined;
}

function judgeModels(records: readonly EvalRunRecord[]): string[] {
  const models: string[] = [];
  for (const record of records) {
    for (const judge of record.judges ?? []) {
      if (!models.includes(judge.model)) {
        models.push(judge.model);
      }
    }
  }
  return models;
}

function gradeOf(record: EvalRunRecord, model: string): JudgeRecord | undefined {
  return record.judges?.find((judge) => judge.model === model);
}

function summarizeJudge(records: readonly EvalRunRecord[], model: string): JudgeSummary {
  const entries = records.flatMap((record) => {
    const grade = gradeOf(record, model);
    return grade === undefined ? [] : [{ record, grade }];
  });
  const graded = entries.filter((entry) => entry.grade.status === "graded");
  const referenced = graded.filter((entry) => judgeReference(entry.record) !== undefined);
  return {
    model,
    graded: graded.length,
    errors: entries.filter((entry) => entry.grade.status === "error").length,
    skipped: entries.filter((entry) => entry.grade.status === "skipped").length,
    passed: rate(graded, (entry) => entry.grade.verdict === "pass"),
    accuracy: rate(referenced, (entry) => (entry.grade.verdict === "pass") === judgeReference(entry.record)),
    reviewerAgreement: rate(graded, (entry) => (entry.grade.verdict === "pass") === entry.record.approved),
    costUsd: entries.reduce((sum, entry) => sum + entry.grade.costUsd, 0),
  };
}

function judgeAgreement(records: readonly EvalRunRecord[], models: readonly string[]): RateMetric | null {
  const [first, second] = models;
  if (models.length !== 2 || first === undefined || second === undefined) {
    return null;
  }
  const pairs = records.flatMap((record) => {
    const a = gradeOf(record, first);
    const b = gradeOf(record, second);
    return a?.status === "graded" && b?.status === "graded" ? [[a.verdict, b.verdict] as const] : [];
  });
  return rate(
    pairs.map(([a, b]) => ({ same: a === b })),
    (pair) => pair.same,
  );
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
  const models = judgeModels(records);
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
    judges: models.map((model) => summarizeJudge(records, model)),
    judgeAgreement: judgeAgreement(records, models),
    judgeCostUsd: records.reduce((sum, record) => sum + (record.judges ?? []).reduce((total, judge) => total + judge.costUsd, 0), 0),
  };
}
