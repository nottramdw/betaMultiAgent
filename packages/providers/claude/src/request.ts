import type Anthropic from "@anthropic-ai/sdk";
import { ProviderError, type AssistantMessage, type Message, type ModelInfo, type ProviderRequest, type UserMessage } from "@betamultiagent/core";

export const CLAUDE_PROVIDER_ID = "claude";

export interface ClaudeRequestOptions {
  readonly strictTools: boolean;
}

export function readRequestOptions(providerOptions: ProviderRequest["providerOptions"]): ClaudeRequestOptions {
  const strictTools = providerOptions?.["strictTools"];
  if (strictTools === undefined) {
    return { strictTools: true };
  }
  if (typeof strictTools !== "boolean") {
    throw new ProviderError("invalid-request", "providerOptions.strictTools must be a boolean");
  }
  return { strictTools };
}

function userBlocks(message: UserMessage): Anthropic.ContentBlockParam[] {
  const results: Anthropic.ContentBlockParam[] = [];
  const texts: Anthropic.ContentBlockParam[] = [];
  for (const part of message.parts) {
    if (part.type === "tool-result") {
      results.push({
        type: "tool_result",
        tool_use_id: part.toolCallId,
        content: part.content,
        ...(part.isError ? { is_error: true } : {}),
      });
    } else if (part.text.length > 0) {
      texts.push({ type: "text", text: part.text });
    }
  }
  return [...results, ...texts];
}

function orderUserBlocks(blocks: Anthropic.ContentBlockParam[]): Anthropic.ContentBlockParam[] {
  return [...blocks.filter((block) => block.type === "tool_result"), ...blocks.filter((block) => block.type !== "tool_result")];
}

function assistantContent(message: AssistantMessage): Anthropic.ContentBlockParam[] {
  if (message.native.provider !== CLAUDE_PROVIDER_ID) {
    throw new ProviderError(
      "invalid-request",
      `assistant message from provider ${message.native.provider} cannot be replayed to ${CLAUDE_PROVIDER_ID}`,
    );
  }
  const payload: unknown = message.native.payload;
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new ProviderError("invalid-request", "assistant native payload must be a non-empty content block array");
  }
  const blocks: unknown[] = payload;
  return blocks as Anthropic.ContentBlockParam[];
}

export function buildMessages(history: readonly Message[]): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];
  for (const message of history) {
    const last = messages.at(-1);
    if (message.role === "user") {
      const blocks = userBlocks(message);
      if (blocks.length === 0) {
        throw new ProviderError("invalid-request", "user message has no content");
      }
      if (last?.role === "user" && Array.isArray(last.content)) {
        last.content = orderUserBlocks([...last.content, ...blocks]);
      } else {
        messages.push({ role: "user", content: orderUserBlocks(blocks) });
      }
    } else if (message.role === "assistant") {
      messages.push({ role: "assistant", content: assistantContent(message) });
    } else if (last?.role === "system" && typeof last.content === "string") {
      last.content = `${last.content}\n\n${message.text}`;
    } else if (last?.role === "user") {
      messages.push({ role: "system", content: message.text });
    } else {
      throw new ProviderError("invalid-request", "system note must directly follow a user message");
    }
  }
  return messages;
}

function buildTools(request: ProviderRequest, options: ClaudeRequestOptions): Anthropic.Tool[] {
  return [...request.tools]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Tool["input_schema"],
      ...(options.strictTools ? { strict: true } : {}),
      eager_input_streaming: true,
    }));
}

export function buildMessageParams(request: ProviderRequest, model: ModelInfo): Anthropic.MessageCreateParamsStreaming {
  if (request.maxOutputTokens > model.maxOutput) {
    throw new ProviderError(
      "invalid-request",
      `maxOutputTokens ${String(request.maxOutputTokens)} exceeds ${String(model.maxOutput)} for ${model.id}`,
    );
  }
  if (request.effort !== undefined && !model.effortLevels.includes(request.effort)) {
    throw new ProviderError("invalid-request", `model ${model.id} does not support effort ${request.effort}`);
  }
  const options = readRequestOptions(request.providerOptions);
  const tools = buildTools(request, options);
  return {
    model: request.model,
    max_tokens: request.maxOutputTokens,
    stream: true,
    cache_control: { type: "ephemeral" },
    messages: buildMessages(request.history),
    thinking: { type: "adaptive", display: "summarized" },
    ...(request.system.length === 0
      ? {}
      : { system: [{ type: "text" as const, text: request.system, cache_control: { type: "ephemeral" as const } }] }),
    ...(tools.length === 0
      ? {}
      : { tools, tool_choice: request.toolChoice === "auto" ? { type: "auto" as const } : { type: "none" as const } }),
    ...(request.effort === undefined ? {} : { output_config: { effort: request.effort } }),
  };
}
