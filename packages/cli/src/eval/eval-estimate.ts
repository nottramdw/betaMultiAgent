import { defaultTeamRoles, estimateCostUsd, TEAM_ROLES, type AgentRole, type ModelRef, type PriceTier, type TeamRoles } from "@betamultiagent/core";
import { modelLabel } from "../judge/model-judge.js";
import { taskTurns, type EvalTask } from "./eval-suite.js";

export type EvalProvider = "claude" | "grok";

export const DEFAULT_TURN_PROFILE: Readonly<Record<AgentRole, number>> = {
  lead: 4,
  researcher: 0,
  executor: 12,
  reviewer: 4,
};

export const TOKEN_PROFILE = {
  baseInputTokens: 6000,
  inputTokensPerTurn: 1500,
  outputTokensPerTurn: 1000,
} as const;

export const JUDGE_TOKEN_PROFILE = {
  inputTokens: 20_000,
  outputTokens: 1500,
  maxInputTokens: 50_000,
  maxOutputTokens: 4000,
} as const;

export interface RoleEstimate {
  readonly model: string;
  readonly turns: number;
  readonly costUsd: number;
}

export interface TaskEstimate {
  readonly taskId: string;
  readonly costUsd: number;
  readonly roles: Readonly<Partial<Record<AgentRole, RoleEstimate>>>;
}

export interface JudgeEstimate {
  readonly model: string;
  readonly costUsd: number;
  readonly maxCostUsd: number;
}

export interface SuiteEstimate {
  readonly provider: EvalProvider;
  readonly runs: number;
  readonly tasks: readonly TaskEstimate[];
  readonly judges: readonly JudgeEstimate[];
  readonly expectedUsd: number;
  readonly capUsd?: number;
  readonly unpriced: readonly string[];
}

export type PricingLookup = (model: ModelRef) => readonly PriceTier[];

export interface EstimateOptions {
  readonly models?: Readonly<Record<AgentRole, ModelRef>>;
  readonly judges?: readonly ModelRef[];
}

export function providerRoles(provider: EvalProvider): TeamRoles {
  return defaultTeamRoles({ claude: provider === "claude", grok: provider === "grok" });
}

export function roleTurnsCost(turns: number, tiers: readonly PriceTier[]): number | undefined {
  let total = 0;
  for (let turn = 0; turn < turns; turn += 1) {
    const prompt = TOKEN_PROFILE.baseInputTokens + TOKEN_PROFILE.inputTokensPerTurn * turn;
    const cost = requestCost(prompt, TOKEN_PROFILE.outputTokensPerTurn, tiers);
    if (cost === undefined) {
      return undefined;
    }
    total += cost;
  }
  return total;
}

function requestCost(inputTokens: number, outputTokens: number, tiers: readonly PriceTier[]): number | undefined {
  return estimateCostUsd({ promptTokens: inputTokens, inputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens }, tiers);
}

export function estimateSuite(
  provider: EvalProvider,
  tasks: readonly EvalTask[],
  repeat: number,
  maxCostUsd: number | undefined,
  pricing: PricingLookup,
  options: EstimateOptions = {},
): SuiteEstimate {
  const defaults = providerRoles(provider);
  const unpriced = new Set<string>();
  const estimates = tasks.map((task): TaskEstimate => {
    const turns = taskTurns(task, DEFAULT_TURN_PROFILE);
    const byRole: Partial<Record<AgentRole, RoleEstimate>> = {};
    let total = 0;
    for (const role of TEAM_ROLES) {
      const ref = options.models?.[role] ?? defaults[role].model;
      const model = modelLabel(ref);
      const cost = roleTurnsCost(turns[role], pricing(ref));
      if (cost === undefined) {
        unpriced.add(model);
      }
      byRole[role] = { model, turns: turns[role], costUsd: cost ?? 0 };
      total += cost ?? 0;
    }
    return { taskId: task.id, costUsd: total, roles: byRole };
  });
  const judges = (options.judges ?? []).map((ref): JudgeEstimate => {
    const tiers = pricing(ref);
    const expected = requestCost(JUDGE_TOKEN_PROFILE.inputTokens, JUDGE_TOKEN_PROFILE.outputTokens, tiers);
    const worst = requestCost(JUDGE_TOKEN_PROFILE.maxInputTokens, JUDGE_TOKEN_PROFILE.maxOutputTokens, tiers);
    if (expected === undefined || worst === undefined) {
      unpriced.add(modelLabel(ref));
    }
    return { model: modelLabel(ref), costUsd: expected ?? 0, maxCostUsd: worst ?? 0 };
  });
  const runs = tasks.length * repeat;
  const judgeUsd = judges.reduce((sum, judge) => sum + judge.costUsd, 0);
  const judgeMaxUsd = judges.reduce((sum, judge) => sum + judge.maxCostUsd, 0);
  const expectedUsd = (estimates.reduce((sum, item) => sum + item.costUsd, 0) + judgeUsd * tasks.length) * repeat;
  return {
    provider,
    runs,
    tasks: estimates,
    judges,
    expectedUsd,
    ...(maxCostUsd === undefined ? {} : { capUsd: runs * (maxCostUsd + judgeMaxUsd) }),
    unpriced: [...unpriced].sort(),
  };
}
