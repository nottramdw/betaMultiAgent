import type Anthropic from "@anthropic-ai/sdk";
import { estimateCostUsd, type ModelInfo, type Usage } from "@betamultiagent/core";

export interface RawUsage {
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number | undefined;
}

export function usageFromStart(usage: Anthropic.Usage): RawUsage {
  return {
    inputTokens: usage.input_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    outputTokens: usage.output_tokens,
    reasoningTokens: usage.output_tokens_details?.thinking_tokens,
  };
}

export function mergeDeltaUsage(current: RawUsage, delta: Anthropic.MessageDeltaUsage): RawUsage {
  return {
    inputTokens: delta.input_tokens ?? current.inputTokens,
    cacheReadTokens: delta.cache_read_input_tokens ?? current.cacheReadTokens,
    cacheWriteTokens: delta.cache_creation_input_tokens ?? current.cacheWriteTokens,
    outputTokens: delta.output_tokens,
    reasoningTokens: delta.output_tokens_details?.thinking_tokens ?? current.reasoningTokens,
  };
}

export function toUsage(raw: RawUsage, responseModel: string, priced: ModelInfo): Usage {
  const counts = {
    promptTokens: raw.inputTokens + raw.cacheReadTokens + raw.cacheWriteTokens,
    inputTokens: raw.inputTokens,
    cacheReadTokens: raw.cacheReadTokens,
    cacheWriteTokens: raw.cacheWriteTokens,
    outputTokens: raw.outputTokens,
  };
  const base = {
    ...counts,
    model: responseModel,
    ...(raw.reasoningTokens === undefined ? {} : { reasoningTokens: raw.reasoningTokens }),
  };
  const cost = priced.pricing === undefined ? undefined : estimateCostUsd(counts, priced.pricing);
  return cost === undefined ? { ...base, costSource: "unknown" } : { ...base, costUsd: cost, costSource: "estimated" };
}
