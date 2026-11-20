import { z } from "zod";

export const DecisionSchema = z.enum(["allow", "ask", "deny"]);
export type Decision = z.infer<typeof DecisionSchema>;

export const PermissionRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("read"), paths: z.array(z.string().min(1)).min(1) }),
  z.object({ kind: z.literal("write"), paths: z.array(z.string().min(1)).min(1) }),
  z.object({ kind: z.literal("exec"), argv: z.array(z.string()).min(1), cwd: z.string().min(1) }),
]);
export type PermissionRequest = z.infer<typeof PermissionRequestSchema>;

export const PathRuleSchema = z.object({
  kind: z.enum(["read", "write"]),
  match: z.string().min(1),
  decision: DecisionSchema,
});
export type PathRule = z.infer<typeof PathRuleSchema>;

export const ExecRuleSchema = z.object({
  kind: z.literal("exec"),
  match: z.array(z.string().min(1)).min(1),
  decision: DecisionSchema,
});
export type ExecRule = z.infer<typeof ExecRuleSchema>;

export const RuleSchema = z.discriminatedUnion("kind", [
  PathRuleSchema.extend({ kind: z.literal("read") }),
  PathRuleSchema.extend({ kind: z.literal("write") }),
  ExecRuleSchema,
]);
export type Rule = z.infer<typeof RuleSchema>;

export const PermissionsSchema = z.object({
  rules: z.array(RuleSchema),
  extraReadRoots: z.array(z.string().min(1)),
});
export type Permissions = z.infer<typeof PermissionsSchema>;

export type VerdictSource = "hard-deny" | "rule" | "session" | "default" | "fallback";

export interface PermissionVerdict {
  readonly decision: Decision;
  readonly source: VerdictSource;
  readonly reason: string;
  readonly sensitive: boolean;
}

export type ApprovalAnswer = "allow-once" | "allow-session" | "deny";

export type Approver = (request: PermissionRequest, verdict: PermissionVerdict) => Promise<ApprovalAnswer>;

export interface PermissionOutcome {
  readonly allowed: boolean;
  readonly verdict: PermissionVerdict;
  readonly approval?: ApprovalAnswer;
}

export class PermissionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionConfigError";
  }
}
