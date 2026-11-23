import { AgentRoleSchema, EffortSchema, ModelRefSchema, RuleSchema, type ModelRef } from "@betamultiagent/core";
import { z } from "zod";
import { usageError } from "../cli-error.js";

const MODEL_PATTERN = /^(claude|grok):([A-Za-z0-9][A-Za-z0-9._-]*)$/u;

export function parseModelSpec(text: string, effort?: ModelRef["effort"]): ModelRef {
  const match = MODEL_PATTERN.exec(text);
  if (match === null) {
    throw usageError(`invalid model ${JSON.stringify(text)}; expected <provider>:<model-id> with provider claude or grok`);
  }
  return ModelRefSchema.parse({ provider: match[1], id: match[2], ...(effort === undefined ? {} : { effort }) });
}

const RoleConfigSchema = z.strictObject({
  model: z.string().regex(MODEL_PATTERN, "expected <provider>:<model-id> with provider claude or grok").optional(),
  effort: EffortSchema.optional(),
  instructions: z.string().min(1).optional(),
  maxTurns: z.number().int().positive().optional(),
  maxCostUsd: z.number().positive().optional(),
});
export type RoleConfigInput = z.infer<typeof RoleConfigSchema>;

const RolesSchema = z.partialRecord(AgentRoleSchema, RoleConfigSchema);

const BudgetConfigSchema = z.strictObject({
  maxCostUsd: z.number().positive().optional(),
  maxWallMinutes: z.number().int().positive().optional(),
  dailyMaxCostUsd: z.number().positive().optional(),
});
export type BudgetConfig = z.infer<typeof BudgetConfigSchema>;

const CommandSchema = z.array(z.string().min(1)).min(1);

export const MIN_AUDIT_RETENTION_DAYS = 30;
export const DEFAULT_AUDIT_RETENTION_DAYS = 180;

export const ConfigFileSchema = z.strictObject({
  roles: RolesSchema.optional(),
  permissions: z.strictObject({ rules: z.array(RuleSchema) }).optional(),
  budget: BudgetConfigSchema.optional(),
  env: z.strictObject({ passthrough: z.array(z.string()) }).optional(),
  skills: z.strictObject({ extraRoots: z.array(z.string().min(1)) }).optional(),
  team: z.strictObject({ setup: z.array(CommandSchema) }).optional(),
  audit: z.strictObject({ retentionDays: z.number().int().min(MIN_AUDIT_RETENTION_DAYS).optional() }).optional(),
});
export type ConfigFile = z.infer<typeof ConfigFileSchema>;

const SECRET_KEY_PATTERN = /api[-_]?key|token|secret|password|passwd|credential|private[-_]?key|auth/iu;

export function secretLikeKeys(value: unknown, at = "$"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => secretLikeKeys(item, `${at}[${String(index)}]`));
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  return Object.entries(value).flatMap(([key, item]) => [
    ...(SECRET_KEY_PATTERN.test(key) ? [`${at}.${key}`] : []),
    ...secretLikeKeys(item, `${at}.${key}`),
  ]);
}
