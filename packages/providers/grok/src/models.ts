import { ProviderError, type Effort, type ModelInfo, type ModelRef, type PriceTier } from "@betamultiagent/core";

export const PRICING_AS_OF = "2026-11-20";

const LONG_CONTEXT_THRESHOLD = 200_000;

function tier(
  maxPromptTokens: number | null,
  inputPerMTok: number,
  outputPerMTok: number,
  cacheReadPerMTok: number,
): PriceTier {
  return { maxPromptTokens, inputPerMTok, outputPerMTok, cacheReadPerMTok, cacheWritePerMTok: 0 };
}

function model(
  id: string,
  contextWindow: number,
  effortLevels: Effort[],
  standard: PriceTier,
  longContext: PriceTier,
): ModelInfo {
  return {
    id,
    contextWindow,
    maxOutput: 128_000,
    defaultMaxOutput: 32_000,
    effortLevels,
    pricing: [standard, longContext],
    pricingAsOf: PRICING_AS_OF,
  };
}

export const models: readonly ModelInfo[] = [
  model(
    "grok-4.7",
    500_000,
    ["low", "medium", "high", "xhigh"],
    tier(LONG_CONTEXT_THRESHOLD - 1, 2, 6, 0.5),
    tier(null, 4, 12, 1),
  ),
  model("grok-4.3", 1_000_000, ["low", "medium", "high", "xhigh"], tier(LONG_CONTEXT_THRESHOLD - 1, 1.25, 2.5, 0.2), tier(null, 2.5, 5, 0.4)),
];

export function findModel(id: string): ModelInfo | undefined {
  return models.find((entry) => entry.id === id);
}

export function parseModelRef(ref: Pick<ModelRef, "id" | "effort">): ModelInfo {
  const info = findModel(ref.id);
  if (info === undefined) {
    throw new ProviderError("invalid-request", `model ${ref.id} is not in the grok catalog`);
  }
  if (ref.effort !== undefined && !info.effortLevels.includes(ref.effort)) {
    throw new ProviderError("invalid-request", `model ${ref.id} does not support effort ${ref.effort}`);
  }
  return info;
}
