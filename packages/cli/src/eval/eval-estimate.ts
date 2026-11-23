import { defaultTeamRoles, estimateCostUsd, TEAM_ROLES, type AgentRole, type PriceTier, type TeamRoles } from "@betamultiagent/core";
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

export interface SuiteEstimate {
  readonly provider: EvalProvider;
  readonly runs: number;
  readonly tasks: readonly TaskEstimate[];
  readonly expectedUsd: number;
  readonly capUsd?: number;
  readonly unpriced: readonly string[];
}

export type PricingLookup = (role: AgentRole, roles: TeamRoles) => readonly PriceTier[];

export function providerRoles(provider: EvalProvider): TeamRoles {
  return defaultTeamRoles({ claude: provider === "claude", grok: provider === "grok" });
}

export function roleTurnsCost(turns: number, tiers: readonly PriceTier[]): number | undefined {
  let total = 0;
  for (let turn = 0; turn < turns; turn += 1) {
    const prompt = TOKEN_PROFILE.baseInputTokens + TOKEN_PROFILE.inputTokensPerTurn * turn;
    const cost = estimateCostUsd(
      { promptTokens: prompt, inputTokens: prompt, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: TOKEN_PROFILE.outputTokensPerTurn },
      tiers,
    );
    if (cost === undefined) {
      return undefined;
    }
    total += cost;
  }
  return total;
}

export function estimateSuite(
  provider: EvalProvider,
  tasks: readonly EvalTask[],
  repeat: number,
  maxCostUsd: number | undefined,
  pricing: PricingLookup,
): SuiteEstimate {
  const roles = providerRoles(provider);
  const unpriced = new Set<string>();
  const estimates = tasks.map((task): TaskEstimate => {
    const turns = taskTurns(task, DEFAULT_TURN_PROFILE);
    const byRole: Partial<Record<AgentRole, RoleEstimate>> = {};
    let total = 0;
    for (const role of TEAM_ROLES) {
      const model = `${roles[role].model.provider}:${roles[role].model.id}`;
      const cost = roleTurnsCost(turns[role], pricing(role, roles));
      if (cost === undefined) {
        unpriced.add(model);
      }
      byRole[role] = { model, turns: turns[role], costUsd: cost ?? 0 };
      total += cost ?? 0;
    }
    return { taskId: task.id, costUsd: total, roles: byRole };
  });
  const runs = tasks.length * repeat;
  const expectedUsd = estimates.reduce((sum, item) => sum + item.costUsd, 0) * repeat;
  return {
    provider,
    runs,
    tasks: estimates,
    expectedUsd,
    ...(maxCostUsd === undefined ? {} : { capUsd: runs * maxCostUsd }),
    unpriced: [...unpriced].sort(),
  };
}
