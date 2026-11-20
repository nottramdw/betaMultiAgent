import type { AssistantMessage, StopDetails, StopReason } from "../messages/messages.js";
import { ProviderError, type Provider, type ProviderEvent, type ProviderRequest } from "../provider/provider.js";
import type { Usage } from "../usage/usage.js";

export interface ScriptedResponse {
  readonly parts?: AssistantMessage["parts"];
  readonly text?: string;
  readonly stopReason?: StopReason;
  readonly stopDetails?: StopDetails;
  readonly usage?: Partial<Usage>;
  readonly model?: string;
  readonly native?: unknown;
}

export type ScriptedReply = ScriptedResponse | ProviderError;

export interface ScriptStep {
  expect?(request: ProviderRequest): void;
  readonly respond: ScriptedReply | ((request: ProviderRequest) => ScriptedReply);
}

export class ScriptViolation extends Error {
  readonly step: number;

  constructor(step: number, message: string) {
    super(`script step ${String(step)}: ${message}`);
    this.name = "ScriptViolation";
    this.step = step;
  }
}

export interface ScriptedProviderOptions {
  readonly id?: string;
  readonly model?: string;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ProviderError("aborted", "request aborted");
  }
}

function emptyUsage(model: string): Usage {
  return {
    promptTokens: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    costSource: "unknown",
    model,
  };
}

export class ScriptedProvider implements Provider {
  readonly id: string;
  readonly requests: ProviderRequest[] = [];
  readonly #steps: readonly ScriptStep[];
  readonly #model: string;
  #cursor = 0;

  constructor(steps: readonly ScriptStep[], options: ScriptedProviderOptions = {}) {
    this.id = options.id ?? "scripted";
    this.#model = options.model ?? "scripted-model";
    this.#steps = steps;
  }

  get remaining(): number {
    return this.#steps.length - this.#cursor;
  }

  assertDone(): void {
    if (this.remaining > 0) {
      throw new ScriptViolation(this.#cursor, `${String(this.remaining)} scripted step(s) were never requested`);
    }
  }

  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    const index = this.#cursor;
    const step = this.#steps[index];
    this.requests.push({ ...request, history: [...request.history], tools: [...request.tools] });
    if (step === undefined) {
      throw new ScriptViolation(index, "unexpected request after the script ended");
    }
    this.#cursor += 1;
    try {
      step.expect?.(request);
    } catch (error) {
      throw new ScriptViolation(index, error instanceof Error ? error.message : String(error));
    }
    throwIfAborted(signal);
    const reply = typeof step.respond === "function" ? step.respond(request) : step.respond;
    if (reply instanceof ProviderError) {
      throw reply;
    }
    const message = this.#toMessage(reply, request);
    for (const part of message.parts) {
      await Promise.resolve();
      throwIfAborted(signal);
      if (part.type === "text") {
        yield { type: "text-delta", text: part.text };
      } else if (part.type === "reasoning") {
        yield { type: "reasoning-delta", text: part.text };
      } else {
        yield { type: "tool-call-delta", id: part.id, name: part.name, inputDelta: JSON.stringify(part.input) };
      }
    }
    yield { type: "complete", message };
  }

  #toMessage(reply: ScriptedResponse, request: ProviderRequest): AssistantMessage {
    const parts = reply.parts ?? (reply.text === undefined ? [] : [{ type: "text" as const, text: reply.text }]);
    const model = reply.model ?? (request.model.length > 0 ? request.model : this.#model);
    const hasToolCall = parts.some((part) => part.type === "tool-call");
    return {
      role: "assistant",
      parts,
      native: { provider: this.id, payload: reply.native ?? null },
      provider: this.id,
      model,
      stopReason: reply.stopReason ?? (hasToolCall ? "tool-calls" : "end"),
      ...(reply.stopDetails === undefined ? {} : { stopDetails: reply.stopDetails }),
      usage: { ...emptyUsage(model), ...reply.usage },
    };
  }
}
