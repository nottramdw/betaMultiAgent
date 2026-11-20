import type { AgentRole, Rule } from "@betamultiagent/core";
import type { BudgetConfig, ConfigFile, RoleConfigInput } from "./schema.js";

export interface EffectiveConfig {
  readonly trusted: boolean;
  readonly rules: readonly Rule[];
  readonly roles: Partial<Record<AgentRole, RoleConfigInput>>;
  readonly budget: BudgetConfig;
  readonly passthrough: readonly string[];
  readonly extraSkillRoots: readonly string[];
  readonly setup: readonly (readonly string[])[];
  readonly warnings: readonly string[];
}

function lower(user: number | undefined, project: number | undefined): number | undefined {
  if (user === undefined) {
    return project;
  }
  return project === undefined ? user : Math.min(user, project);
}

function mergeBudget(user: BudgetConfig | undefined, project: BudgetConfig | undefined): BudgetConfig {
  const maxCostUsd = lower(user?.maxCostUsd, project?.maxCostUsd);
  const maxWallMinutes = lower(user?.maxWallMinutes, project?.maxWallMinutes);
  return {
    ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
    ...(maxWallMinutes === undefined ? {} : { maxWallMinutes }),
  };
}

export function mergeConfig(user: ConfigFile, project: ConfigFile, trusted: boolean): EffectiveConfig {
  const warnings: string[] = [];
  if (project.skills?.extraRoots !== undefined) {
    warnings.push("skills.extraRoots is only read from the user configuration; the project value is ignored");
  }
  const projectRules = project.permissions?.rules ?? [];
  const rules = [
    ...(user.permissions?.rules ?? []),
    ...(trusted ? projectRules : projectRules.filter((rule) => rule.decision !== "allow")),
  ];
  return {
    trusted,
    rules,
    roles: { ...user.roles, ...(trusted ? project.roles : {}) },
    budget: mergeBudget(user.budget, trusted ? project.budget : undefined),
    passthrough: [...new Set([...(user.env?.passthrough ?? []), ...(trusted ? (project.env?.passthrough ?? []) : [])])],
    extraSkillRoots: user.skills?.extraRoots ?? [],
    setup: trusted ? (project.team?.setup ?? user.team?.setup ?? []) : [],
    warnings,
  };
}
