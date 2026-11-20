import type { DiffStatEntry } from "../environment/environment.js";
import { SUBMIT_PLAN, SUBMIT_RESULT, SUBMIT_REVIEW, type TeamCommand, type TeamPlan, type TeamResult, type TeamReview } from "./completion-tools.js";
import type { DelegateTask } from "./delegate-tool.js";
import type { CommandRun } from "./verification-gate.js";

export type VerificationStatus = "passed" | "failed" | "skipped";

export interface VerificationSummary {
  readonly status: VerificationStatus;
  readonly runs: readonly CommandRun[];
  readonly unapproved: readonly TeamCommand[];
}

export interface ReviewDiff {
  readonly text?: string;
  readonly stat?: readonly DiffStatEntry[];
}

function argvText(command: TeamCommand): string {
  return JSON.stringify(command.argv);
}

function bulletList(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

function fenced(text: string, language = ""): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/gu)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${language}\n${text}\n${fence}`;
}

export function leadHandoff(task: string): string {
  return ["# Task", task.trim()].join("\n");
}

export function researchHandoff(task: DelegateTask): string {
  return [`# Research task: ${task.title}`, task.prompt.trim()].join("\n\n");
}

export function planCorrection(problems: readonly string[]): string {
  return [
    "The submitted plan was rejected:",
    bulletList(problems),
    `Fix these problems and call \`${SUBMIT_PLAN}\` again with the complete corrected plan.`,
  ].join("\n\n");
}

export function executorHandoff(task: string, plan: TeamPlan, verify: readonly TeamCommand[]): string {
  const commands = verify.length === 0 ? "- (none approved)" : bulletList(verify.map(argvText));
  return [
    "# Task",
    task.trim(),
    "# Plan",
    fenced(JSON.stringify(plan, null, 2), "json"),
    "# Scope",
    "- Change only paths matched by an `inScope` pattern.",
    "- Never change paths matched by an `outOfScope` pattern.",
    "- Changes to sensitive files (package manifests, lockfiles, CI, hooks, agent configuration) stop the run for human review.",
    "# Verification commands run after you finish",
    commands,
    `Call \`${SUBMIT_RESULT}\` when the plan is implemented.`,
  ].join("\n\n");
}

export function scopeFeedback(violations: readonly string[]): string {
  return [
    "These changed paths are outside the plan's scope:",
    bulletList(violations),
    `Revert them so that every change stays within \`inScope\` and outside \`outOfScope\`, then call \`${SUBMIT_RESULT}\` again.`,
  ].join("\n\n");
}

export function verificationFeedback(run: CommandRun): string {
  const status = run.timedOut ? "timed out" : `exited with code ${String(run.exitCode)}`;
  return [
    `Verification command ${argvText(run.command)} ${status}. Output tail:`,
    fenced(run.outputTail),
    `Fix the problem, then call \`${SUBMIT_RESULT}\` again.`,
  ].join("\n\n");
}

export function reviewFeedback(review: TeamReview): string {
  const findings = review.findings.map((finding) => {
    const location = finding.path === undefined ? "" : ` ${finding.path}${finding.line === undefined ? "" : `:${String(finding.line)}`}`;
    return `[${finding.severity}]${location} ${finding.message}`;
  });
  return [
    "The reviewer requested changes.",
    review.summary,
    findings.length === 0 ? "" : bulletList(findings),
    `Address the findings, then call \`${SUBMIT_RESULT}\` again.`,
  ]
    .filter((block) => block.length > 0)
    .join("\n\n");
}

function verificationSection(verification: VerificationSummary): string {
  const lines = [`Status: ${verification.status}`];
  for (const run of verification.runs) {
    lines.push(`- ${argvText(run.command)}: ${run.ok ? "passed" : run.timedOut ? "timed out" : `exit ${String(run.exitCode)}`}`);
  }
  for (const command of verification.unapproved) {
    lines.push(`- ${argvText(command)}: not run (not approved)`);
  }
  return lines.join("\n");
}

function diffSection(diff: ReviewDiff): string {
  if (diff.text !== undefined) {
    return diff.text.length === 0 ? "(no changes)" : fenced(diff.text, "diff");
  }
  const stat = (diff.stat ?? []).map(
    (entry) => `${entry.added === null ? "-" : String(entry.added)}\t${entry.removed === null ? "-" : String(entry.removed)}\t${entry.path}`,
  );
  return [
    "The diff is too large to include. Changed files (added, removed, path) follow; read the files you need.",
    fenced(stat.join("\n")),
  ].join("\n\n");
}

export interface ReviewerHandoffInput {
  readonly task: string;
  readonly plan: TeamPlan;
  readonly result: TeamResult;
  readonly verification: VerificationSummary;
  readonly diff: ReviewDiff;
}

export function reviewerHandoff(input: ReviewerHandoffInput): string {
  return [
    "# Task",
    input.task.trim(),
    "# Plan",
    fenced(JSON.stringify(input.plan, null, 2), "json"),
    "# Executor report",
    [input.result.summary, input.result.notes ?? ""].filter((part) => part.length > 0).join("\n\n"),
    "# Verification",
    verificationSection(input.verification),
    "# Diff against the base commit",
    diffSection(input.diff),
    `Call \`${SUBMIT_REVIEW}\` with your verdict.`,
  ].join("\n\n");
}
