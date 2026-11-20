import { z } from "zod";
import { defineTool, type ToolDefinition } from "../tools/tool-definition.js";

export const SUBMIT_PLAN = "submit_plan";
export const SUBMIT_RESULT = "submit_result";
export const SUBMIT_REVIEW = "submit_review";
export const MAX_COMMAND_TIMEOUT_MS = 600_000;

export const TeamCommandSchema = z.object({
  argv: z.array(z.string()).min(1).describe("Program followed by its arguments. No shell is involved."),
  timeoutMs: z
    .number()
    .int()
    .min(1)
    .max(MAX_COMMAND_TIMEOUT_MS)
    .optional()
    .describe("Time limit in milliseconds. Defaults to the environment limit."),
});
export type TeamCommand = z.infer<typeof TeamCommandSchema>;

export const TeamPlanSchema = z.object({
  title: z.string().min(1).max(72).describe("Short imperative title, used as the commit subject."),
  summary: z.string().min(1).describe("What will change and why."),
  steps: z
    .array(
      z.object({
        id: z.string().min(1),
        title: z.string().min(1),
        detail: z.string(),
      }),
    )
    .min(1),
  inScope: z
    .array(z.string().min(1))
    .min(1)
    .describe("POSIX glob patterns, relative to the workspace root, matching every path the executor may change."),
  outOfScope: z
    .array(z.string().min(1))
    .describe("POSIX glob patterns, relative to the workspace root, matching paths that must not change."),
  verify: z.array(TeamCommandSchema).describe("Commands that prove the change works, run in order after execution."),
  stopConditions: z.array(z.string().min(1)).describe("Situations in which the executor must stop and report."),
});
export type TeamPlan = z.infer<typeof TeamPlanSchema>;

export const TeamResultSchema = z.object({
  summary: z.string().min(1),
  notes: z.string().optional(),
});
export type TeamResult = z.infer<typeof TeamResultSchema>;

export const ReviewVerdictSchema = z.enum(["approve", "revise", "block"]);
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;

export const TeamReviewSchema = z.object({
  verdict: ReviewVerdictSchema,
  findings: z.array(
    z.object({
      severity: z.enum(["blocker", "major", "minor"]),
      path: z.string().min(1).optional(),
      line: z.number().int().min(1).optional(),
      message: z.string().min(1),
    }),
  ),
  summary: z.string().min(1),
});
export type TeamReview = z.infer<typeof TeamReviewSchema>;

function completionTool<I>(name: string, description: string, input: z.ZodType<I>): ToolDefinition<I, I> {
  return defineTool({
    name,
    description,
    input,
    capabilities: { readOnly: true },
    permission: () => ({ kind: "none" }),
    execute: (value) => Promise.resolve({ output: value, promptText: "submitted", isError: false }),
  });
}

export function createSubmitPlanTool(): ToolDefinition<TeamPlan, TeamPlan> {
  return completionTool(
    SUBMIT_PLAN,
    "Submit the implementation plan. Call it alone, once the plan is complete.",
    TeamPlanSchema,
  );
}

export function createSubmitResultTool(): ToolDefinition<TeamResult, TeamResult> {
  return completionTool(SUBMIT_RESULT, "Submit the final result of your task. Call it alone, once the task is done.", TeamResultSchema);
}

export function createSubmitReviewTool(): ToolDefinition<TeamReview, TeamReview> {
  return completionTool(
    SUBMIT_REVIEW,
    "Submit the review verdict with its findings. Call it alone, once the review is complete.",
    TeamReviewSchema,
  );
}
