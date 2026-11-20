import { z } from "zod";
import type { AssistantMessage, Message, ProviderId } from "../messages/messages.js";
import type { ToolSpec } from "../tools/tool-spec.js";
import { PriceTierSchema } from "../usage/usage.js";

export const EffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type Effort = z.infer<typeof EffortSchema>;

export type ToolChoice = "auto" | "none";

export interface ProviderRequest {
  readonly model: string;
  readonly system: string;
  readonly tools: readonly ToolSpec[];
  readonly history: readonly Message[];
  readonly effort?: Effort;
  readonly maxOutputTokens: number;
  readonly toolChoice: ToolChoice;
  readonly cacheKey: string;
  readonly providerOptions?: Readonly<Record<string, unknown>>;
}

export type ProviderEvent =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "reasoning-delta"; readonly text: string }
  | { readonly type: "tool-call-delta"; readonly id: string; readonly name?: string; readonly inputDelta: string }
  | { readonly type: "server-tool"; readonly name: string; readonly status: "started" | "completed" | "failed" }
  | { readonly type: "complete"; readonly message: AssistantMessage };

export interface Provider {
  readonly id: ProviderId;
  stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
}

export const ProviderErrorKindSchema = z.enum([
  "auth",
  "permission",
  "rate-limit",
  "quota",
  "overloaded",
  "server",
  "network",
  "stream-interrupted",
  "context-exceeded",
  "invalid-request",
  "aborted",
  "unknown",
]);
export type ProviderErrorKind = z.infer<typeof ProviderErrorKindSchema>;

const RETRYABLE_KINDS: ReadonlySet<ProviderErrorKind> = new Set([
  "rate-limit",
  "overloaded",
  "server",
  "network",
  "stream-interrupted",
]);

export function isRetryableKind(kind: ProviderErrorKind): boolean {
  return RETRYABLE_KINDS.has(kind);
}

export interface ProviderErrorOptions {
  readonly status?: number;
  readonly requestId?: string;
  readonly cause?: unknown;
}

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly requestId: string | undefined;

  constructor(kind: ProviderErrorKind, message: string, options: ProviderErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProviderError";
    this.kind = kind;
    this.status = options.status;
    this.retryable = isRetryableKind(kind);
    this.requestId = options.requestId;
  }
}

export const ModelInfoSchema = z.object({
  id: z.string().min(1),
  contextWindow: z.number().int().positive(),
  maxOutput: z.number().int().positive(),
  defaultMaxOutput: z.number().int().positive(),
  effortLevels: z.array(EffortSchema),
  pricing: z.array(PriceTierSchema).optional(),
  pricingAsOf: z.string().optional(),
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;
