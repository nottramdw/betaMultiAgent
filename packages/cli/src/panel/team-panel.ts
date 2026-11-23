import type { TeamOutcome, TeamStatus, VerificationStatus } from "@betamultiagent/core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CliIo } from "../cli-io.js";
import { JUDGE_TIMEOUT_MS, runJudge, truncateDiff, type JudgeRecord, type JudgeTarget } from "../judge/model-judge.js";
import { displayValue } from "../output/sanitize.js";
import type { TerminalWriter } from "../output/human.js";
import { CREDENTIAL_VARIABLES } from "../wiring.js";

const execFileAsync = promisify(execFile);

export const MIN_CANDIDATES = 2;
export const MAX_CANDIDATES = 4;

export interface PanelCandidate {
  readonly index: number;
  readonly runId: string;
  readonly status: TeamStatus;
  readonly branch?: string;
  readonly commit?: string;
  readonly verification: VerificationStatus;
  readonly revisions: number;
  readonly costUsd: number;
  readonly judges?: readonly JudgeRecord[];
  readonly eligible: boolean;
  readonly reasons: readonly string[];
}

export interface PanelResult {
  readonly candidates: readonly PanelCandidate[];
  readonly selected?: number;
  readonly judgeCostUsd: number;
  readonly costUsd: number;
}

export interface PanelGrading {
  readonly goal: string;
  readonly acceptance: readonly string[];
  readonly judges: readonly JudgeTarget[];
  readonly root: string;
  readonly env: CliIo["env"];
  readonly signal: AbortSignal;
  readonly spend?: JudgeSpend;
}

export interface JudgeSpend {
  allowed(): Promise<boolean>;
  charge(costUsd: number): Promise<void>;
}

export function ineligibility(outcome: TeamOutcome, judges: readonly JudgeRecord[] | undefined): string[] {
  const reasons: string[] = [];
  if (outcome.status !== "approved") {
    reasons.push(`status ${outcome.status}`);
  }
  if (outcome.commit === undefined) {
    reasons.push("no commit");
  }
  if (outcome.verification !== "passed") {
    reasons.push(`verification ${outcome.verification}`);
  } else if (outcome.verificationRuns.length === 0) {
    reasons.push("no verification command ran");
  }
  if (outcome.criteria !== undefined) {
    const open = outcome.criteria.filter((criterion) => criterion.status !== "PASS").map((criterion) => criterion.id);
    if (open.length > 0) {
      reasons.push(`criteria not PASS: ${open.join(", ")}`);
    }
  } else if (outcome.acceptance !== undefined && outcome.acceptance.length > 0) {
    reasons.push("criteria not assessed");
  }
  if (outcome.sensitiveChanges.length > 0) {
    reasons.push("sensitive changes");
  }
  for (const judge of judges ?? []) {
    if (judge.status !== "graded") {
      reasons.push(`judge ${judge.model}: ${judge.status}`);
    } else if (judge.verdict !== "pass") {
      reasons.push(`judge ${judge.model}: ${judge.verdict ?? "no verdict"}`);
    }
  }
  return reasons;
}

export function selectCandidate(candidates: readonly PanelCandidate[]): number | undefined {
  const ranked = candidates
    .filter((candidate) => candidate.eligible)
    .sort((a, b) => a.revisions - b.revisions || a.costUsd - b.costUsd || a.index - b.index);
  return ranked[0]?.index;
}

function gitEnv(env: CliIo["env"]): Record<string, string> {
  const blocked = new Set<string>(CREDENTIAL_VARIABLES);
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && !blocked.has(entry[0])));
}

export async function candidateDiff(root: string, base: string, commit: string, env: CliIo["env"]): Promise<{ readonly text: string; readonly truncated: boolean }> {
  const result = await execFileAsync("git", ["diff", "--no-color", "--no-ext-diff", "--no-textconv", base, commit], {
    cwd: root,
    env: gitEnv(env),
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  return truncateDiff(result.stdout);
}

export async function gradeCandidate(outcome: TeamOutcome, grading: PanelGrading): Promise<JudgeRecord[] | undefined> {
  if (grading.judges.length === 0) {
    return undefined;
  }
  if (outcome.commit === undefined || outcome.baseCommit === undefined) {
    return grading.judges.map((judge) => ({ model: judge.label, status: "skipped", message: "the run left no commit to grade", costUsd: 0 }));
  }
  const diff = await candidateDiff(grading.root, outcome.baseCommit, outcome.commit, grading.env);
  const input = {
    goal: grading.goal,
    acceptance: grading.acceptance,
    rubric: [],
    diff: diff.text,
    diffTruncated: diff.truncated,
    verification: outcome.verificationRuns,
  };
  const records: JudgeRecord[] = [];
  for (const judge of grading.judges) {
    if (grading.spend !== undefined && !(await grading.spend.allowed())) {
      records.push({ model: judge.label, status: "skipped", message: "the daily cost cap is reached", costUsd: 0 });
      continue;
    }
    const record = await runJudge(judge, input, AbortSignal.any([grading.signal, AbortSignal.timeout(JUDGE_TIMEOUT_MS)]));
    await grading.spend?.charge(record.costUsd);
    records.push(record);
  }
  return records;
}

export function buildPanel(outcomes: readonly TeamOutcome[], grades: readonly (readonly JudgeRecord[] | undefined)[]): PanelResult {
  const candidates = outcomes.map((outcome, position): PanelCandidate => {
    const judges = grades[position];
    const reasons = ineligibility(outcome, judges);
    return {
      index: position + 1,
      runId: outcome.runId,
      status: outcome.status,
      ...(outcome.branch === undefined ? {} : { branch: outcome.branch }),
      ...(outcome.commit === undefined ? {} : { commit: outcome.commit }),
      verification: outcome.verification,
      revisions: outcome.revisions,
      costUsd: outcome.usage.costUsd,
      ...(judges === undefined ? {} : { judges }),
      eligible: reasons.length === 0,
      reasons,
    };
  });
  const selected = selectCandidate(candidates);
  const judgeCostUsd = grades.flatMap((records) => records ?? []).reduce((sum, record) => sum + record.costUsd, 0);
  const costUsd = candidates.reduce((sum, candidate) => sum + candidate.costUsd, 0) + judgeCostUsd;
  return { candidates, ...(selected === undefined ? {} : { selected }), judgeCostUsd, costUsd };
}

export function printPanelSummary(out: TerminalWriter, panel: PanelResult): void {
  out.line(`panel of ${String(panel.candidates.length)} candidates:`);
  for (const candidate of panel.candidates) {
    const branch = candidate.branch === undefined ? "" : ` ${candidate.branch}`;
    out.line(
      `  #${String(candidate.index)} run ${candidate.runId}: ${candidate.status}, verification ${candidate.verification}, revisions ${String(candidate.revisions)}, $${candidate.costUsd.toFixed(4)}${branch}`,
    );
    for (const judge of candidate.judges ?? []) {
      const detail = judge.status === "graded" ? (judge.verdict ?? "") : (judge.message ?? judge.status);
      out.line(`    judge ${judge.model}: ${judge.status === "graded" ? detail : `${judge.status}, ${displayValue(detail, 300)}`}`);
    }
    if (!candidate.eligible) {
      out.line(`    not selectable: ${candidate.reasons.join("; ")}`);
    }
  }
  if (panel.judgeCostUsd > 0) {
    out.line(`judge cost: $${panel.judgeCostUsd.toFixed(4)}`);
  }
  out.line(`total cost: $${panel.costUsd.toFixed(4)}`);
  const selected = panel.candidates.find((candidate) => candidate.index === panel.selected);
  if (selected === undefined) {
    out.line("no candidate passed every check; nothing was selected. Review the branches before merging any of them.");
    return;
  }
  out.line(`selected: #${String(selected.index)}${selected.branch === undefined ? "" : ` (${selected.branch})`}. It is not merged; review the diff before merging.`);
}
