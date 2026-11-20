import { z } from "zod";
import { ProviderIdSchema, StopDetailsSchema } from "../messages/messages.js";
import { PermissionsSchema } from "../permissions/permission-types.js";
import { EffortSchema } from "../provider/provider.js";
import { BudgetSchema } from "../usage/usage.js";

export const AgentRoleSchema = z.enum(["lead", "executor", "reviewer", "researcher"]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

export const ModelRefSchema = z.object({
  provider: ProviderIdSchema,
  id: z.string().min(1),
  effort: EffortSchema.optional(),
});
export type ModelRef = z.infer<typeof ModelRefSchema>;

export const AgentNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);

export const AgentSpecSchema = z.object({
  name: AgentNameSchema,
  role: AgentRoleSchema,
  instructions: z.string(),
  model: ModelRefSchema,
  tools: z.array(z.string().min(1)),
  permissions: PermissionsSchema,
  budget: BudgetSchema,
  completion: z.object({ tool: z.string().min(1) }).optional(),
});
export type AgentSpec = z.infer<typeof AgentSpecSchema>;

export const TurnOutcomeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("completed"), text: z.string(), result: z.unknown().optional() }),
  z.object({ type: z.literal("refused"), stopDetails: StopDetailsSchema.optional() }),
  z.object({ type: z.literal("budget-exceeded"), budget: z.enum(["turns", "cost", "wall"]) }),
  z.object({ type: z.literal("loop-detected"), tool: z.string() }),
  z.object({ type: z.literal("max-tokens") }),
  z.object({ type: z.literal("aborted") }),
  z.object({ type: z.literal("failed"), code: z.string().min(1), message: z.string() }),
]);
export type TurnOutcome = z.infer<typeof TurnOutcomeSchema>;
