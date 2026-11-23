import {
  MAX_ACCEPTANCE_CRITERIA,
  MAX_CRITERION_LENGTH,
  type CriterionStatus,
  type TeamReview,
} from "./completion-tools.js";

export type CriterionSource = "user" | "lead";

export interface AcceptanceCriterion {
  readonly id: string;
  readonly text: string;
  readonly source: CriterionSource;
}

export interface CriterionResult extends AcceptanceCriterion {
  readonly status: CriterionStatus;
  readonly note: string;
}

function comparable(text: string): string {
  return text.replace(/\s+/gu, " ").trim().toLowerCase();
}

export function acceptanceProblems(criteria: readonly string[]): string[] {
  const problems: string[] = [];
  if (criteria.length > MAX_ACCEPTANCE_CRITERIA) {
    problems.push(`at most ${String(MAX_ACCEPTANCE_CRITERIA)} acceptance criteria are allowed, got ${String(criteria.length)}`);
  }
  criteria.forEach((text, index) => {
    if (text.trim().length === 0) {
      problems.push(`acceptance criterion ${String(index + 1)} is empty`);
    } else if (text.length > MAX_CRITERION_LENGTH) {
      problems.push(`acceptance criterion ${String(index + 1)} is longer than ${String(MAX_CRITERION_LENGTH)} characters`);
    }
  });
  return problems;
}

export function mergeAcceptance(user: readonly string[], lead: readonly string[]): AcceptanceCriterion[] {
  const seen = new Set<string>();
  const merged: { text: string; source: CriterionSource }[] = [];
  for (const [source, list] of [
    ["user", user],
    ["lead", lead],
  ] as const) {
    for (const text of list) {
      const key = comparable(text);
      if (key.length === 0 || seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push({ text: text.trim(), source });
    }
  }
  return merged.map((entry, index) => ({ id: `AC${String(index + 1)}`, ...entry }));
}

export function criterionResults(acceptance: readonly AcceptanceCriterion[], review: Pick<TeamReview, "criteria">): CriterionResult[] {
  return acceptance.flatMap((criterion) => {
    const assessment = review.criteria[criterion.id];
    return assessment === undefined ? [] : [{ ...criterion, status: assessment.status, note: assessment.note }];
  });
}
