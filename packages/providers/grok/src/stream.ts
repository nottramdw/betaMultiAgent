import type { AssistantMessage, ModelInfo, ProviderEvent, StopReason } from "@betamultiagent/core";
import { ProviderError } from "@betamultiagent/core";
import {
  isFunctionCall,
  isMessage,
  isReasoning,
  toInput,
  type FunctionToolCall,
  type ModelResponse,
  type OutputItem,
  type ReasoningItem,
  type ResponseStreamEvent,
} from "@xai-official/sdk";
import { failedResponseError } from "./errors.js";
import { GROK_PROVIDER_ID } from "./request.js";
import { toUsage } from "./usage.js";

const LOCAL_ITEM_TYPES: ReadonlySet<string> = new Set(["message", "reasoning", "function_call"]);

function itemType(item: unknown): string | undefined {
  if (typeof item !== "object" || item === null || !("type" in item)) {
    return undefined;
  }
  return typeof item.type === "string" ? item.type : undefined;
}

function serverToolType(item: unknown): string | undefined {
  const type = itemType(item);
  return type !== undefined && !LOCAL_ITEM_TYPES.has(type) ? type : undefined;
}

const NON_OUTPUT_EVENTS: ReadonlySet<string> = new Set([
  "ping",
  "error",
  "unknown",
  "response.created",
  "response.in_progress",
]);

export function isOutputEvent(event: ResponseStreamEvent): boolean {
  return !NON_OUTPUT_EVENTS.has(event.type);
}

export function mapIncompleteReason(reason: string | undefined): StopReason {
  switch (reason) {
    case "max_output_tokens":
      return "max-tokens";
    case "max_prompt_tokens":
      return "context-exceeded";
    case "content_filter":
      return "refusal";
    default:
      return "other";
  }
}

function parseArguments(raw: string): { input: unknown; invalid: boolean } {
  if (raw.trim().length === 0) {
    return { input: {}, invalid: false };
  }
  try {
    return { input: JSON.parse(raw) as unknown, invalid: false };
  } catch {
    return { input: {}, invalid: true };
  }
}

function reasoningText(item: ReasoningItem): string {
  const content = (item.content ?? []).map((entry) => entry.text).join("");
  return content.length > 0 ? content : item.summary.map((entry) => entry.text).join("");
}

export class GrokStreamState {
  readonly #requestModel: ModelInfo;
  readonly #callByItem = new Map<string, string>();
  readonly #callByIndex = new Map<number, string>();

  constructor(model: ModelInfo) {
    this.#requestModel = model;
  }

  *accept(event: ResponseStreamEvent): Generator<ProviderEvent> {
    switch (event.type) {
      case "response.output_item.added":
        yield* this.#itemAdded(event.item, event.output_index);
        break;
      case "response.output_item.done": {
        const type = serverToolType(event.item);
        if (type !== undefined) {
          yield { type: "server-tool", name: type, status: "completed" };
        }
        break;
      }
      case "response.output_text.delta":
        if (event.delta.length > 0) {
          yield { type: "text-delta", text: event.delta };
        }
        break;
      case "response.reasoning_text.delta":
      case "response.reasoning_summary_text.delta":
        if (event.delta.length > 0) {
          yield { type: "reasoning-delta", text: event.delta };
        }
        break;
      case "response.function_call_arguments.delta": {
        const id = this.#resolveCall(event.item_id, event.output_index);
        if (id !== undefined && event.delta.length > 0) {
          yield { type: "tool-call-delta", id, inputDelta: event.delta };
        }
        break;
      }
      default:
        break;
    }
  }

  *#itemAdded(item: OutputItem, outputIndex: number): Generator<ProviderEvent> {
    if (isFunctionCall(item)) {
      this.#registerCall(item, outputIndex);
      yield { type: "tool-call-delta", id: item.call_id, name: item.name, inputDelta: "" };
      return;
    }
    const type = serverToolType(item);
    if (type !== undefined) {
      yield { type: "server-tool", name: type, status: "started" };
    }
  }

  #registerCall(item: FunctionToolCall, outputIndex: number): void {
    this.#callByIndex.set(outputIndex, item.call_id);
    if (item.id !== undefined) {
      this.#callByItem.set(item.id, item.call_id);
    }
  }

  #resolveCall(itemId: string | undefined, outputIndex: number | undefined): string | undefined {
    if (itemId !== undefined) {
      const byItem = this.#callByItem.get(itemId);
      if (byItem !== undefined) {
        return byItem;
      }
    }
    return outputIndex === undefined ? undefined : this.#callByIndex.get(outputIndex);
  }

  finish(response: ModelResponse): AssistantMessage {
    if (response.status === "failed") {
      throw failedResponseError(response);
    }
    const incomplete = response.status === "incomplete";
    if (!incomplete && response.status !== "completed") {
      throw new ProviderError("stream-interrupted", `response ended with status ${response.status}`);
    }
    const parts: AssistantMessage["parts"] = [];
    let refused = false;
    let called = false;
    for (const item of response.output) {
      if (isReasoning(item)) {
        const text = reasoningText(item);
        if (text.length > 0) {
          parts.push({ type: "reasoning", text });
        }
      } else if (isMessage(item)) {
        for (const content of item.content) {
          if (content.type === "refusal") {
            refused = true;
            if (content.refusal.length > 0) {
              parts.push({ type: "text", text: content.refusal });
            }
          } else if (content.text.length > 0) {
            parts.push({ type: "text", text: content.text });
          }
        }
      } else if (isFunctionCall(item) && !incomplete) {
        const parsed = parseArguments(item.arguments);
        called = true;
        parts.push({
          type: "tool-call",
          id: item.call_id,
          name: item.name,
          input: parsed.input,
          ...(parsed.invalid ? { inputError: "invalid-json" as const } : {}),
        });
      }
    }
    const replay = incomplete ? response.output.filter((item) => !isFunctionCall(item)) : response.output;
    const payload = toInput(replay);
    const model = typeof response.model === "string" && response.model.length > 0 ? response.model : this.#requestModel.id;
    return {
      role: "assistant",
      parts,
      native: { provider: GROK_PROVIDER_ID, payload },
      provider: GROK_PROVIDER_ID,
      model,
      stopReason: stopReasonOf(response, incomplete, refused, called),
      usage: toUsage(response.usage, model, this.#requestModel),
    };
  }
}

function stopReasonOf(response: ModelResponse, incomplete: boolean, refused: boolean, called: boolean): StopReason {
  if (incomplete) {
    return mapIncompleteReason(response.incomplete_details?.reason);
  }
  if (refused) {
    return "refusal";
  }
  return called ? "tool-calls" : "end";
}
