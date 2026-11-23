import { ProviderError, type AssistantMessage, type ToolSpec } from "@betamultiagent/core";
import { describe, expect, it } from "vitest";
import { createGrokProvider } from "../src/index.js";
import { baseRequest, callItem, collect, created, fakeFetch, messageItem, sseResponse, terminal, wireResponse } from "./helpers.js";

const idle = new AbortController().signal;

const echo: ToolSpec = {
  name: "echo",
  description: "Echo text.",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
};
const alpha: ToolSpec = { name: "alpha", description: "Alpha.", inputSchema: { type: "object", properties: {} } };

async function bodyOf(request: ReturnType<typeof baseRequest>): Promise<Record<string, unknown>> {
  const { fetch, calls } = fakeFetch(() => sseResponse([created(), terminal("response.completed", wireResponse({ output: [messageItem("ok")] }))]));
  const provider = createGrokProvider({ apiKey: "k", fetch, maxRetries: 0 });
  await collect(provider.stream(request, idle));
  return calls[0]?.body as Record<string, unknown>;
}

function assistant(payload: unknown, provider = "grok"): AssistantMessage {
  return {
    role: "assistant",
    parts: [{ type: "text", text: "x" }],
    native: { provider, payload },
    provider,
    model: "grok-4.7",
    stopReason: "end",
    usage: {
      promptTokens: 1,
      inputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1,
      reasoningTokens: 0,
      model: "grok-4.7",
      costSource: "unknown",
    },
  };
}

describe("grok request mapping", () => {
  it("maps a plain request", async () => {
    const body = await bodyOf(baseRequest());
    expect(body).toMatchObject({
      model: "grok-4.7",
      instructions: "You are a test agent.",
      input: [{ role: "user", content: "hello" }],
      stream: true,
      store: false,
      prompt_cache_key: "session-1",
      max_output_tokens: 1024,
    });
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
    expect(body).not.toHaveProperty("previous_response_id");
    expect(body).not.toHaveProperty("reasoning");
  });

  it("sorts tools and never sends strict", async () => {
    const body = await bodyOf(baseRequest({ tools: [echo, alpha] }));
    expect(body["tools"]).toEqual([
      { type: "function", name: "alpha", description: "Alpha.", parameters: alpha.inputSchema },
      { type: "function", name: "echo", description: "Echo text.", parameters: echo.inputSchema },
    ]);
    expect(body["tool_choice"]).toBe("auto");
    expect(body["parallel_tool_calls"]).toBe(true);
    expect(JSON.stringify(body)).not.toContain("strict");
  });

  it("sends reasoning effort only when set", async () => {
    const body = await bodyOf(baseRequest({ effort: "high" }));
    expect(body["reasoning"]).toMatchObject({ effort: "high" });
  });

  it("omits empty instructions", async () => {
    const body = await bodyOf(baseRequest({ system: "" }));
    expect(body).not.toHaveProperty("instructions");
  });

  it("rejects an unsupported effort and an oversized output budget", async () => {
    const provider = createGrokProvider({ apiKey: "k", maxRetries: 0 });
    await expect(collect(provider.stream(baseRequest({ model: "grok-4.3", effort: "max" }), idle))).rejects.toMatchObject({
      kind: "invalid-request",
    });
    await expect(collect(provider.stream(baseRequest({ maxOutputTokens: 1_000_000 }), idle))).rejects.toMatchObject({
      kind: "invalid-request",
    });
  });

  it("rejects an unknown model before any request", async () => {
    const { fetch, calls } = fakeFetch(() => sseResponse([]));
    const provider = createGrokProvider({ apiKey: "k", fetch, maxRetries: 0 });
    await expect(collect(provider.stream(baseRequest({ model: "grok-nope" }), idle))).rejects.toBeInstanceOf(ProviderError);
    expect(calls).toHaveLength(0);
  });

  it("places tool outputs before user text and merges consecutive user messages", async () => {
    const native = [callItem("call_1", "echo", '{"text":"a"}')];
    const body = await bodyOf(
      baseRequest({
        history: [
          { role: "user", parts: [{ type: "text", text: "one" }] },
          { role: "user", parts: [{ type: "text", text: "two" }] },
          assistant(native),
          {
            role: "user",
            parts: [
              { type: "text", text: "more" },
              { type: "tool-result", toolCallId: "call_1", content: "a", isError: false },
            ],
          },
        ],
      }),
    );
    expect(body["input"]).toEqual([
      { role: "user", content: "one\n\ntwo" },
      ...native,
      { type: "function_call_output", call_id: "call_1", output: "a" },
      { role: "user", content: "more" },
    ]);
  });

  it("maps system notes to system messages", async () => {
    const body = await bodyOf(
      baseRequest({
        history: [
          { role: "user", parts: [{ type: "text", text: "hi" }] },
          { role: "system", text: "note", reason: "budget-warning" },
        ],
      }),
    );
    expect(body["input"]).toEqual([
      { role: "user", content: "hi" },
      { role: "system", content: "note" },
    ]);
  });

  it("rejects empty user content", async () => {
    const provider = createGrokProvider({ apiKey: "k", maxRetries: 0 });
    const request = baseRequest({ history: [{ role: "user", parts: [{ type: "text", text: "" }] }] });
    await expect(collect(provider.stream(request, idle))).rejects.toMatchObject({ kind: "invalid-request" });
  });

  it("rejects assistant messages from another provider or without payload", async () => {
    const provider = createGrokProvider({ apiKey: "k", maxRetries: 0 });
    const foreign = baseRequest({ history: [assistant([{ type: "text" }], "claude")] });
    const malformed = baseRequest({ history: [assistant("not-an-array")] });
    await expect(collect(provider.stream(foreign, idle))).rejects.toMatchObject({ kind: "invalid-request" });
    await expect(collect(provider.stream(malformed, idle))).rejects.toMatchObject({ kind: "invalid-request" });
  });
});
