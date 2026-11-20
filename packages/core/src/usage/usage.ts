import { z } from "zod";

const tokenCount = z.number().int().nonnegative();
const dollars = z.number().nonnegative();

export const CostSourceSchema = z.enum(["exact", "estimated", "unknown"]);
export type CostSource = z.infer<typeof CostSourceSchema>;

export const UsageSchema = z.object({
  promptTokens: tokenCount,
  inputTokens: tokenCount,
  cacheReadTokens: tokenCount,
  cacheWriteTokens: tokenCount,
  outputTokens: tokenCount,
  reasoningTokens: tokenCount.optional(),
  costUsd: dollars.optional(),
  costSource: CostSourceSchema,
  model: z.string().min(1),
});
export type Usage = z.infer<typeof UsageSchema>;

export const PriceTierSchema = z.object({
  maxPromptTokens: z.number().int().positive().nullable(),
  inputPerMTok: dollars,
  outputPerMTok: dollars,
  cacheReadPerMTok: dollars,
  cacheWritePerMTok: dollars,
});
export type PriceTier = z.infer<typeof PriceTierSchema>;

export const BudgetSchema = z.object({
  maxTurns: z.number().int().positive(),
  maxCostUsd: dollars.optional(),
  maxWallMs: z.number().int().positive().optional(),
});
export type Budget = z.infer<typeof BudgetSchema>;

export function selectPriceTier(tiers: readonly PriceTier[], promptTokens: number): PriceTier | undefined {
  const ordered = [...tiers].sort(
    (a, b) => (a.maxPromptTokens ?? Number.POSITIVE_INFINITY) - (b.maxPromptTokens ?? Number.POSITIVE_INFINITY),
  );
  return ordered.find((tier) => tier.maxPromptTokens === null || promptTokens <= tier.maxPromptTokens);
}

export function estimateCostUsd(
  usage: Pick<Usage, "promptTokens" | "inputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "outputTokens">,
  tiers: readonly PriceTier[],
): number | undefined {
  const tier = selectPriceTier(tiers, usage.promptTokens);
  if (tier === undefined) {
    return undefined;
  }
  const perToken = (count: number, perMillion: number): number => (count * perMillion) / 1_000_000;
  return (
    perToken(usage.inputTokens, tier.inputPerMTok) +
    perToken(usage.cacheReadTokens, tier.cacheReadPerMTok) +
    perToken(usage.cacheWriteTokens, tier.cacheWritePerMTok) +
    perToken(usage.outputTokens, tier.outputPerMTok)
  );
}

export interface UsageTotals {
  readonly turns: number;
  readonly promptTokens: number;
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly costUsd: number;
  readonly costSource: CostSource;
}

const EMPTY_TOTALS: UsageTotals = {
  turns: 0,
  promptTokens: 0,
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  costUsd: 0,
  costSource: "exact",
};

function usageCostSource(usage: Usage): CostSource {
  return usage.costUsd === undefined ? "unknown" : usage.costSource;
}

function mergeCostSource(totals: UsageTotals, next: CostSource): CostSource {
  if (totals.turns === 0) {
    return next;
  }
  return totals.costSource === next ? next : "estimated";
}

export class UsageLedger {
  readonly agentName: string;
  readonly #parent: UsageLedger | undefined;
  #totals: UsageTotals = EMPTY_TOTALS;

  constructor(agentName: string, parent?: UsageLedger) {
    this.agentName = agentName;
    this.#parent = parent;
  }

  child(agentName: string): UsageLedger {
    return new UsageLedger(agentName, this);
  }

  record(usage: Usage): void {
    const totals = this.#totals;
    this.#totals = {
      turns: totals.turns + 1,
      promptTokens: totals.promptTokens + usage.promptTokens,
      inputTokens: totals.inputTokens + usage.inputTokens,
      cacheReadTokens: totals.cacheReadTokens + usage.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens + usage.cacheWriteTokens,
      outputTokens: totals.outputTokens + usage.outputTokens,
      reasoningTokens: totals.reasoningTokens + (usage.reasoningTokens ?? 0),
      costUsd: totals.costUsd + (usage.costUsd ?? 0),
      costSource: mergeCostSource(totals, usageCostSource(usage)),
    };
    this.#parent?.record(usage);
  }

  snapshot(): UsageTotals {
    return this.#totals;
  }
}

export type BudgetCheck = { readonly ok: true } | { readonly ok: false; readonly exceeded: "turns" | "cost" | "wall" };

export function checkBudget(budget: Budget, totals: UsageTotals, elapsedMs: number): BudgetCheck {
  if (totals.turns >= budget.maxTurns) {
    return { ok: false, exceeded: "turns" };
  }
  if (budget.maxCostUsd !== undefined && totals.costUsd >= budget.maxCostUsd) {
    return { ok: false, exceeded: "cost" };
  }
  if (budget.maxWallMs !== undefined && elapsedMs >= budget.maxWallMs) {
    return { ok: false, exceeded: "wall" };
  }
  return { ok: true };
}
