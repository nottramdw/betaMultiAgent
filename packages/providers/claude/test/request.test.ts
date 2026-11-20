import { ProviderError, type Message, type ToolSpec } from "@betamultiagent/core";
import { describe, expect, it } from "vitest";
import { parseModelRef } from "../src/index.js";
import { buildMessageParams, buildMessages } from "../src/request.js";
import { baseRequest } from "./helpers.js";

const sonnet = parseModelRef({ id: "claude-sonnet-5-5" });

const toolB: ToolSpec = {
  name: "b_tool",
  description: "second",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
};
const toolA: ToolSpec = {
  name: "a_tool",
  description: "first",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

function invalidRequest(action: () => unknown): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: "invalid-request", retryable: false });
    return;
  }
  throw new Error("expected a ProviderError");
}

describe("claude request mapping", () => {
  it("maps a provider request to message parameters", () => {
    const params = buildMessageParams(baseRequest({ tools: [toolB, toolA], effort: "high" }), sonnet);
    expect(params).toEqual({
      model: "claude-sonnet-5-5",
      max_tokens: 1024,
      stream: true,
      cache_control: { type: "ephemeral" },
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      thinking: { type: "adaptive", display: "summarized" },
      system: [{ type: "text", text: "You are a test agent.", cache_control: { type: "ephemeral" } }],
      tools: [
        {
          name: "a_tool",
          description: "first",
          input_schema: toolA.inputSchema,
          strict: true,
          eager_input_streaming: true,
        },
        {
          name: "b_tool",
          description: "second",
          input_schema: toolB.inputSchema,
          strict: true,
          eager_input_streaming: true,
        },
      ],
      tool_choice: { type: "auto" },
      output_config: { effort: "high" },
    });
  });

  it("never sends sampling, budget, prefill or fallback fields", () => {
    const params = buildMessageParams(baseRequest({ tools: [toolA], effort: "low" }), sonnet);
    const serialized = JSON.stringify(params);
    for (const forbidden of ["temperature", "top_p", "top_k", "budget_tokens", "fallbacks", "prefix_mismatch"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("drops strict when strictTools is disabled", () => {
    const params = buildMessageParams(baseRequest({ tools: [toolA], providerOptions: { strictTools: false } }), sonnet);
    expect(params.tools?.[0]).not.toHaveProperty("strict");
    expect(params.tools?.[0]).toHaveProperty("eager_input_streaming", true);
  });

  it("rejects a non-boolean strictTools option", () => {
    invalidRequest(() => buildMessageParams(baseRequest({ providerOptions: { strictTools: "no" } }), sonnet));
  });

  it("omits tools and tool_choice when no tools are declared", () => {
    const params = buildMessageParams(baseRequest({ toolChoice: "none" }), sonnet);
    expect(params).not.toHaveProperty("tools");
    expect(params).not.toHaveProperty("tool_choice");
  });

  it("maps toolChoice none without ever using any or tool", () => {
    const params = buildMessageParams(baseRequest({ tools: [toolA], toolChoice: "none" }), sonnet);
    expect(params.tool_choice).toEqual({ type: "none" });
  });

  it("omits an empty system prompt and effort", () => {
    const params = buildMessageParams(baseRequest({ system: "" }), sonnet);
    expect(params).not.toHaveProperty("system");
    expect(params).not.toHaveProperty("output_config");
  });

  it("rejects output budgets above the model limit", () => {
    invalidRequest(() => buildMessageParams(baseRequest({ maxOutputTokens: 128_001 }), sonnet));
  });

  it("merges consecutive user messages and places tool results first", () => {
    const history: Message[] = [
      { role: "user", parts: [{ type: "text", text: "first" }] },
      {
        role: "user",
        parts: [
          { type: "text", text: "second" },
          { type: "tool-result", toolCallId: "t1", content: "ok", isError: false },
          { type: "tool-result", toolCallId: "t2", content: "boom", isError: true },
        ],
      },
    ];
    expect(buildMessages(history)).toEqual([
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "ok" },
          { type: "tool_result", tool_use_id: "t2", content: "boom", is_error: true },
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      },
    ]);
  });

  it("maps system notes after a user message and merges consecutive notes", () => {
    const history: Message[] = [
      { role: "user", parts: [{ type: "text", text: "go" }] },
      { role: "system", reason: "context-update", text: "one" },
      { role: "system", reason: "loop-nudge", text: "two" },
    ];
    expect(buildMessages(history)).toEqual([
      { role: "user", content: [{ type: "text", text: "go" }] },
      { role: "system", content: "one\n\ntwo" },
    ]);
  });

  it("rejects a system note that does not follow a user message", () => {
    invalidRequest(() => buildMessages([{ role: "system", reason: "context-update", text: "orphan" }]));
  });

  it("rejects a user message without content", () => {
    invalidRequest(() => buildMessages([{ role: "user", parts: [{ type: "text", text: "" }] }]));
  });

  it("replays native assistant content verbatim", () => {
    const payload = [
      { type: "thinking", thinking: "plan", signature: "sig-abc" },
      { type: "redacted_thinking", data: "opaque" },
      { type: "tool_use", id: "t1", name: "a_tool", input: { x: 1 }, caller: { type: "direct" } },
    ];
    const history: Message[] = [
      { role: "user", parts: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        parts: [{ type: "tool-call", id: "t1", name: "a_tool", input: { x: 1 } }],
        native: { provider: "claude", payload },
        provider: "claude",
        model: "claude-sonnet-5-5",
        stopReason: "tool-calls",
        usage: {
          promptTokens: 1,
          inputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 1,
          costSource: "unknown",
          model: "claude-sonnet-5-5",
        },
      },
      { role: "user", parts: [{ type: "tool-result", toolCallId: "t1", content: "done", isError: false }] },
    ];
    const messages = buildMessages(history);
    expect(JSON.stringify(messages[1]?.content)).toBe(JSON.stringify(payload));
  });

  it("rejects assistant messages produced by another provider", () => {
    const history: Message[] = [
      { role: "user", parts: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        parts: [{ type: "text", text: "hi" }],
        native: { provider: "grok", payload: [] },
        provider: "grok",
        model: "grok-4.7",
        stopReason: "end",
        usage: {
          promptTokens: 1,
          inputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 1,
          costSource: "unknown",
          model: "grok-4.7",
        },
      },
    ];
    invalidRequest(() => buildMessages(history));
  });
});
