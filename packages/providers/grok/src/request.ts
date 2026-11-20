import { ProviderError, type AssistantMessage, type Message, type ModelInfo, type ProviderRequest, type UserMessage } from "@betamultiagent/core";
import type { CreateParams, InputItem, Tool } from "@xai-official/sdk";

export const GROK_PROVIDER_ID = "grok";

export type GrokCreateParams = CreateParams & { stream: true };

function replayItems(message: AssistantMessage): InputItem[] {
  if (message.native.provider !== GROK_PROVIDER_ID) {
    throw new ProviderError(
      "invalid-request",
      `assistant message from provider ${message.native.provider} cannot be replayed to ${GROK_PROVIDER_ID}`,
    );
  }
  const payload: unknown = message.native.payload;
  if (!Array.isArray(payload)) {
    throw new ProviderError("invalid-request", "assistant native payload must be an input item array");
  }
  const items: unknown[] = payload;
  return items as InputItem[];
}

function userItems(message: UserMessage): InputItem[] {
  const items: InputItem[] = [];
  const texts: string[] = [];
  for (const part of message.parts) {
    if (part.type === "tool-result") {
      items.push({ type: "function_call_output", call_id: part.toolCallId, output: part.content });
    } else if (part.text.length > 0) {
      texts.push(part.text);
    }
  }
  if (texts.length > 0) {
    items.push({ role: "user", content: texts.join("\n\n") });
  }
  return items;
}

function isPlainUserItem(item: InputItem | undefined): item is { role: string; content: string } {
  return item !== undefined && "role" in item && item.role === "user" && "content" in item && typeof item.content === "string";
}

export function buildInput(history: readonly Message[]): InputItem[] {
  const items: InputItem[] = [];
  for (const message of history) {
    if (message.role === "user") {
      const fresh = userItems(message);
      if (fresh.length === 0) {
        throw new ProviderError("invalid-request", "user message has no content");
      }
      const previous = items.at(-1);
      const only = fresh.length === 1 ? fresh[0] : undefined;
      if (isPlainUserItem(previous) && isPlainUserItem(only)) {
        previous.content = `${previous.content}\n\n${only.content}`;
      } else {
        items.push(...fresh);
      }
    } else if (message.role === "assistant") {
      items.push(...replayItems(message));
    } else {
      items.push({ role: "system", content: message.text });
    }
  }
  return items;
}

function buildTools(request: ProviderRequest): Tool[] {
  return [...request.tools]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    }));
}

export function buildCreateParams(request: ProviderRequest, model: ModelInfo): GrokCreateParams {
  if (request.maxOutputTokens > model.maxOutput) {
    throw new ProviderError(
      "invalid-request",
      `maxOutputTokens ${String(request.maxOutputTokens)} exceeds ${String(model.maxOutput)} for ${model.id}`,
    );
  }
  if (request.effort !== undefined && !model.effortLevels.includes(request.effort)) {
    throw new ProviderError("invalid-request", `model ${model.id} does not support effort ${request.effort}`);
  }
  const tools = buildTools(request);
  return {
    model: request.model,
    input: buildInput(request.history),
    stream: true,
    store: false,
    prompt_cache_key: request.cacheKey,
    max_output_tokens: request.maxOutputTokens,
    ...(request.system.length === 0 ? {} : { instructions: request.system }),
    ...(tools.length === 0 ? {} : { tools, tool_choice: request.toolChoice, parallel_tool_calls: true }),
    ...(request.effort === undefined ? {} : { reasoning: { effort: request.effort } }),
  };
}
