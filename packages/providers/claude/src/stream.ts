import type Anthropic from "@anthropic-ai/sdk";
import {
  ProviderError,
  type AssistantMessage,
  type ModelInfo,
  type ProviderEvent,
  type StopDetails,
  type StopReason,
} from "@betamultiagent/core";
import { CLAUDE_PROVIDER_ID } from "./request.js";
import { mergeDeltaUsage, toUsage, usageFromStart, type RawUsage } from "./usage.js";

const STOP_REASONS: Readonly<Record<string, StopReason>> = {
  end_turn: "end",
  stop_sequence: "end",
  tool_use: "tool-calls",
  max_tokens: "max-tokens",
  pause_turn: "pause",
  refusal: "refusal",
  model_context_window_exceeded: "context-exceeded",
};

export function mapStopReason(reason: Anthropic.StopReason | null): StopReason {
  return (reason === null ? undefined : STOP_REASONS[reason]) ?? "other";
}

export function mapStopDetails(details: Anthropic.RefusalStopDetails | null): StopDetails | undefined {
  if (details === null) {
    return undefined;
  }
  return {
    category: details.category,
    ...(details.explanation === null ? {} : { explanation: details.explanation }),
  };
}

function interrupted(message: string): ProviderError {
  return new ProviderError("stream-interrupted", message);
}

export class ClaudeStreamState {
  readonly #requestModel: ModelInfo;
  readonly #blocks = new Map<number, Anthropic.ContentBlock>();
  readonly #json = new Map<number, string>();
  readonly #open = new Set<number>();
  readonly #invalidJson = new Set<number>();
  #responseModel: string | undefined;
  #usage: RawUsage | undefined;
  #stopReason: Anthropic.StopReason | null = null;
  #stopDetails: Anthropic.RefusalStopDetails | null = null;
  #stopped = false;

  constructor(model: ModelInfo) {
    this.#requestModel = model;
  }

  *accept(event: Anthropic.RawMessageStreamEvent): Generator<ProviderEvent> {
    switch (event.type) {
      case "message_start":
        this.#responseModel = event.message.model;
        this.#usage = usageFromStart(event.message.usage);
        break;
      case "content_block_start":
        yield* this.#start(event.index, structuredClone(event.content_block));
        break;
      case "content_block_delta":
        yield* this.#delta(event.index, event.delta);
        break;
      case "content_block_stop":
        this.#finalize(event.index);
        break;
      case "message_delta":
        this.#stopReason = event.delta.stop_reason;
        this.#stopDetails = event.delta.stop_details;
        if (this.#usage !== undefined) {
          this.#usage = mergeDeltaUsage(this.#usage, event.usage);
        }
        break;
      case "message_stop":
        this.#stopped = true;
        break;
    }
  }

  *#start(index: number, block: Anthropic.ContentBlock): Generator<ProviderEvent> {
    this.#blocks.set(index, block);
    this.#open.add(index);
    if (block.type === "tool_use") {
      this.#json.set(index, "");
      yield { type: "tool-call-delta", id: block.id, name: block.name, inputDelta: "" };
    } else if (block.type === "server_tool_use") {
      this.#json.set(index, "");
      yield { type: "server-tool", name: block.name, status: "started" };
    } else if (block.type === "text" && block.text.length > 0) {
      yield { type: "text-delta", text: block.text };
    } else if (block.type === "thinking" && block.thinking.length > 0) {
      yield { type: "reasoning-delta", text: block.thinking };
    } else if (block.type.endsWith("_tool_result")) {
      yield { type: "server-tool", name: block.type, status: "completed" };
    }
  }

  *#delta(index: number, delta: Anthropic.RawContentBlockDelta): Generator<ProviderEvent> {
    const block = this.#blocks.get(index);
    if (block === undefined) {
      throw interrupted(`content_block_delta for unknown block ${String(index)}`);
    }
    switch (delta.type) {
      case "text_delta":
        if (block.type === "text") {
          block.text += delta.text;
          yield { type: "text-delta", text: delta.text };
        }
        break;
      case "thinking_delta":
        if (block.type === "thinking") {
          block.thinking += delta.thinking;
          yield { type: "reasoning-delta", text: delta.thinking };
        }
        break;
      case "signature_delta":
        if (block.type === "thinking") {
          block.signature = delta.signature;
        }
        break;
      case "input_json_delta":
        if (block.type === "tool_use" || block.type === "server_tool_use") {
          this.#json.set(index, `${this.#json.get(index) ?? ""}${delta.partial_json}`);
          if (block.type === "tool_use") {
            yield { type: "tool-call-delta", id: block.id, inputDelta: delta.partial_json };
          }
        }
        break;
      case "citations_delta":
        break;
    }
  }

  #finalize(index: number): void {
    if (!this.#open.delete(index)) {
      return;
    }
    const block = this.#blocks.get(index);
    if (block === undefined || (block.type !== "tool_use" && block.type !== "server_tool_use")) {
      return;
    }
    const raw = this.#json.get(index) ?? "";
    if (raw.trim().length === 0) {
      block.input = {};
      return;
    }
    try {
      block.input = JSON.parse(raw) as unknown;
    } catch {
      block.input = {};
      this.#invalidJson.add(index);
    }
  }

  finish(): AssistantMessage {
    if (!this.#stopped || this.#usage === undefined || this.#responseModel === undefined) {
      throw interrupted("stream ended before message_stop");
    }
    for (const index of [...this.#open]) {
      this.#finalize(index);
    }
    const ordered = [...this.#blocks.entries()].sort(([a], [b]) => a - b);
    const parts: AssistantMessage["parts"] = [];
    for (const [index, block] of ordered) {
      if (block.type === "text" && block.text.length > 0) {
        parts.push({ type: "text", text: block.text });
      } else if (block.type === "thinking" && block.thinking.length > 0) {
        parts.push({ type: "reasoning", text: block.thinking });
      } else if (block.type === "tool_use") {
        parts.push({
          type: "tool-call",
          id: block.id,
          name: block.name,
          input: block.input,
          ...(this.#invalidJson.has(index) ? { inputError: "invalid-json" as const } : {}),
        });
      }
    }
    const model = this.#responseModel.length > 0 ? this.#responseModel : this.#requestModel.id;
    const stopDetails = mapStopDetails(this.#stopDetails);
    return {
      role: "assistant",
      parts,
      native: { provider: CLAUDE_PROVIDER_ID, payload: ordered.map(([, block]) => block) },
      provider: CLAUDE_PROVIDER_ID,
      model,
      stopReason: mapStopReason(this.#stopReason),
      ...(stopDetails === undefined ? {} : { stopDetails }),
      usage: toUsage(this.#usage, model, this.#requestModel),
    };
  }
}
