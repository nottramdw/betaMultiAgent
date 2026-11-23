import { z } from "zod";
import { defineTool, type ToolDefinition } from "../tools/tool-definition.js";

export const SUBMIT_PLAN = "submit_plan";
export const SUBMIT_RESULT = "submit_result";
export const SUBMIT_REVIEW = "submit_review";
export const MAX_COMMAND_TIMEOUT_MS = 600_000;
export const MAX_ACCEPTANCE_CRITERIA = 10;
export const MAX_CRITERION_LENGTH = 500;
export const MAX_REPORT_ITEMS = 20;
export const MAX_REPORT_ITEM_LENGTH = 2000;

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

const criterionText = z.string().min(1).max(MAX_CRITERION_LENGTH);
const reportItems = z.array(z.string().min(1).max(MAX_REPORT_ITEM_LENGTH)).max(MAX_REPORT_ITEMS);

const acceptanceDescription =
  "Testable acceptance criteria you add to the ones the user set. Each states one observable property of the finished change.";

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
  acceptance: z.array(criterionText).max(MAX_ACCEPTANCE_CRITERIA).describe(acceptanceDescription),
  findings: reportItems.optional().describe("Facts learned while investigating, each citing file paths."),
});
export type TeamPlan = z.infer<typeof TeamPlanSchema>;

export function planSchema(requireAcceptance: boolean): z.ZodType<TeamPlan> {
  if (!requireAcceptance) {
    return TeamPlanSchema;
  }
  return TeamPlanSchema.extend({
    acceptance: z.array(criterionText).min(1).max(MAX_ACCEPTANCE_CRITERIA).describe(acceptanceDescription),
  });
}

export const TeamResultSchema = z.object({
  summary: z.string().min(1),
  notes: z.string().optional(),
});
export type TeamResult = z.infer<typeof TeamResultSchema>;

export const TeamExecutorResultSchema = z.object({
  summary: z.string().min(1).describe("What changed."),
  notes: z.string().optional(),
  stopped: z
    .object({
      condition: z.string().min(1).describe("The plan's stop condition that occurred, quoted exactly."),
      evidence: z.string().min(1).max(MAX_REPORT_ITEM_LENGTH).describe("What you observed that shows the condition holds."),
    })
    .optional()
    .describe("Set only when a stop condition from the plan occurred and you stopped because of it."),
  open: reportItems.optional().describe("Work that remains unfinished."),
});
export type TeamExecutorResult = z.infer<typeof TeamExecutorResultSchema>;

export function executorResultSchema(stopConditions: readonly string[]): z.ZodType<TeamExecutorResult> {
  const [first, ...rest] = [...new Set(stopConditions)];
  if (first === undefined) {
    return TeamExecutorResultSchema.omit({ stopped: true });
  }
  return TeamExecutorResultSchema.extend({
    stopped: z
      .object({
        condition: z.enum([first, ...rest]).describe("The plan's stop condition that occurred."),
        evidence: z.string().min(1).max(MAX_REPORT_ITEM_LENGTH).describe("What you observed that shows the condition holds."),
      })
      .optional()
      .describe("Set only when a stop condition from the plan occurred and you stopped because of it."),
  });
}

export const ReviewVerdictSchema = z.enum(["approve", "revise", "block"]);
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;

export const CriterionStatusSchema = z.enum(["PASS", "FAIL", "NOT_RUN"]);
export type CriterionStatus = z.infer<typeof CriterionStatusSchema>;

export const CriterionAssessmentSchema = z.object({
  status: CriterionStatusSchema,
  note: z.string().min(1).max(MAX_REPORT_ITEM_LENGTH).describe("The evidence for the status, or why the criterion could not be checked."),
});
export type CriterionAssessment = z.infer<typeof CriterionAssessmentSchema>;

const findingsSchema = z.array(
  z.object({
    severity: z.enum(["blocker", "major", "minor"]),
    path: z.string().min(1).optional(),
    line: z.number().int().min(1).optional(),
    message: z.string().min(1),
  }),
);

export const TeamReviewSchema = z.object({
  verdict: ReviewVerdictSchema,
  criteria: z.record(z.string(), CriterionAssessmentSchema),
  findings: findingsSchema,
  summary: z.string().min(1),
});
export type TeamReview = z.infer<typeof TeamReviewSchema>;

export function failedCriteria(review: Pick<TeamReview, "criteria">): string[] {
  return Object.entries(review.criteria)
    .filter(([, assessment]) => assessment.status === "FAIL")
    .map(([id]) => id);
}

export function reviewSchema(criterionIds: readonly string[]): z.ZodType<TeamReview> {
  return z
    .object({
      verdict: ReviewVerdictSchema,
      criteria: z
        .object(Object.fromEntries(criterionIds.map((id) => [id, CriterionAssessmentSchema])))
        .describe("One assessment for every acceptance criterion, keyed by its id."),
      findings: findingsSchema,
      summary: z.string().min(1),
    })
    .superRefine((value, context) => {
      const failed = failedCriteria(value);
      if (value.verdict === "approve" && failed.length > 0) {
        context.addIssue({
          code: "custom",
          path: ["verdict"],
          message: `approve is not allowed while criteria ${failed.join(", ")} are FAIL; choose revise or block, or correct the assessment`,
        });
      }
    });
}

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

export function createSubmitPlanTool(schema: z.ZodType<TeamPlan> = TeamPlanSchema): ToolDefinition<TeamPlan, TeamPlan> {
  return completionTool(SUBMIT_PLAN, "Submit the implementation plan. Call it alone, once the plan is complete.", schema);
}

export function createSubmitResultTool(): ToolDefinition<TeamResult, TeamResult> {
  return completionTool(SUBMIT_RESULT, "Submit the final result of your task. Call it alone, once the task is done.", TeamResultSchema);
}

export function createSubmitExecutorResultTool(
  schema: z.ZodType<TeamExecutorResult> = TeamExecutorResultSchema,
): ToolDefinition<TeamExecutorResult, TeamExecutorResult> {
  return completionTool(
    SUBMIT_RESULT,
    "Submit the result of the implementation. Call it alone, once the plan is implemented or a stop condition occurred.",
    schema,
  );
}

export function createSubmitReviewTool(schema: z.ZodType<TeamReview>): ToolDefinition<TeamReview, TeamReview> {
  return completionTool(
    SUBMIT_REVIEW,
    "Submit the review verdict with an assessment of every acceptance criterion and the findings. Call it alone, once the review is complete.",
    schema,
  );
}
