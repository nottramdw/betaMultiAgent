import { TEAM_ROLES, type AgentRole, type Rule } from "@betamultiagent/core";
import { DEFAULT_AUDIT_RETENTION_DAYS, type BudgetConfig, type ConfigFile, type RoleConfigInput } from "./schema.js";

export interface EffectiveConfig {
  readonly trusted: boolean;
  readonly rules: readonly Rule[];
  readonly roles: Partial<Record<AgentRole, RoleConfigInput>>;
  readonly budget: BudgetConfig;
  readonly passthrough: readonly string[];
  readonly extraSkillRoots: readonly string[];
  readonly setup: readonly (readonly string[])[];
  readonly auditRetentionDays: number;
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

function mergeRole(user: RoleConfigInput | undefined, project: RoleConfigInput | undefined): RoleConfigInput | undefined {
  if (user === undefined || project === undefined) {
    return project ?? user;
  }
  const model = project.model === undefined ? { model: user.model, effort: user.effort } : { model: project.model, effort: project.effort };
  const maxCostUsd = lower(user.maxCostUsd, project.maxCostUsd);
  const instructions = project.instructions ?? user.instructions;
  const maxTurns = project.maxTurns ?? user.maxTurns;
  return {
    ...(model.model === undefined ? {} : { model: model.model }),
    ...(model.effort === undefined ? {} : { effort: model.effort }),
    ...(instructions === undefined ? {} : { instructions }),
    ...(maxTurns === undefined ? {} : { maxTurns }),
    ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
  };
}

function mergeRoles(user: ConfigFile["roles"], project: ConfigFile["roles"]): Partial<Record<AgentRole, RoleConfigInput>> {
  const roles: Partial<Record<AgentRole, RoleConfigInput>> = {};
  for (const role of TEAM_ROLES) {
    const merged = mergeRole(user?.[role], project?.[role]);
    if (merged !== undefined) {
      roles[role] = merged;
    }
  }
  return roles;
}

export function mergeConfig(user: ConfigFile, project: ConfigFile, trusted: boolean): EffectiveConfig {
  const warnings: string[] = [];
  if (project.skills?.extraRoots !== undefined) {
    warnings.push("skills.extraRoots is only read from the user configuration; the project value is ignored");
  }
  if (project.audit !== undefined) {
    warnings.push("audit is only read from the user configuration; the project value is ignored");
  }
  const projectRules = project.permissions?.rules ?? [];
  const rules = [
    ...(user.permissions?.rules ?? []),
    ...(trusted ? projectRules : projectRules.filter((rule) => rule.decision !== "allow")),
  ];
  return {
    trusted,
    rules,
    roles: mergeRoles(user.roles, trusted ? project.roles : undefined),
    budget: mergeBudget(user.budget, trusted ? project.budget : undefined),
    passthrough: [...new Set([...(user.env?.passthrough ?? []), ...(trusted ? (project.env?.passthrough ?? []) : [])])],
    extraSkillRoots: user.skills?.extraRoots ?? [],
    setup: trusted ? (project.team?.setup ?? user.team?.setup ?? []) : [],
    auditRetentionDays: user.audit?.retentionDays ?? DEFAULT_AUDIT_RETENTION_DAYS,
    warnings,
  };
}
