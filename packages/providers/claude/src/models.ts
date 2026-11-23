import { ProviderError, type Effort, type ModelInfo, type ModelRef, type PriceTier } from "@betamultiagent/core";

const EFFORT_LEVELS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

export const PRICING_AS_OF = "2026-11-23";

function tier(
  maxPromptTokens: number | null,
  inputPerMTok: number,
  outputPerMTok: number,
  cacheReadPerMTok: number,
  cacheWritePerMTok: number,
): PriceTier {
  return { maxPromptTokens, inputPerMTok, outputPerMTok, cacheReadPerMTok, cacheWritePerMTok };
}

function model(id: string, pricing: PriceTier[]): ModelInfo {
  return {
    id,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    defaultMaxOutput: 64_000,
    effortLevels: [...EFFORT_LEVELS],
    pricing,
    pricingAsOf: PRICING_AS_OF,
  };
}

export const models: readonly ModelInfo[] = [
  model("claude-opus-5-5", [tier(null, 4, 20, 0.2, 5)]),
  model("claude-sonnet-5-5", [tier(null, 2, 10, 0.1, 2.5)]),
  model("claude-haiku-5-5", [tier(100_000, 0.1, 0.5, 0.01, 0.125), tier(null, 0.5, 2.5, 0.05, 0.625)]),
  model("claude-fable-5-2", [tier(null, 8, 40, 0.2, 10)]),
];

export function findModel(id: string): ModelInfo | undefined {
  return models.find((entry) => entry.id === id);
}

export function parseModelRef(ref: Pick<ModelRef, "id" | "effort">): ModelInfo {
  const info = findModel(ref.id);
  if (info === undefined) {
    throw new ProviderError("invalid-request", `model ${ref.id} is not in the claude catalog`);
  }
  if (ref.effort !== undefined && !info.effortLevels.includes(ref.effort)) {
    throw new ProviderError("invalid-request", `model ${ref.id} does not support effort ${ref.effort}`);
  }
  return info;
}
