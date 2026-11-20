import { estimateCostUsd, type ModelInfo, type Usage as CoreUsage } from "@betamultiagent/core";
import type { Usage } from "@xai-official/sdk";

export function toUsage(usage: Usage, responseModel: string, priced: ModelInfo): CoreUsage {
  const promptTokens = usage.input_tokens;
  const cacheReadTokens = Math.min(usage.input_tokens_details.cached_tokens, promptTokens);
  const counts = {
    promptTokens,
    inputTokens: promptTokens - cacheReadTokens,
    cacheReadTokens,
    cacheWriteTokens: 0,
    outputTokens: Math.max(usage.total_tokens - promptTokens, usage.output_tokens),
  };
  const base = {
    ...counts,
    reasoningTokens: usage.output_tokens_details.reasoning_tokens,
    model: responseModel,
  };
  if (usage.cost_usd !== null) {
    return { ...base, costUsd: usage.cost_usd, costSource: "exact" };
  }
  const estimate = priced.pricing === undefined ? undefined : estimateCostUsd(counts, priced.pricing);
  return estimate === undefined ? { ...base, costSource: "unknown" } : { ...base, costUsd: estimate, costSource: "estimated" };
}
