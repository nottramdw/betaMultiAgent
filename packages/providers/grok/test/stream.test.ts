import { toolCalls, ProviderError, type AssistantMessage, type ProviderEvent } from "@betamultiagent/core";
import { describe, expect, it } from "vitest";
import { createGrokProvider } from "../src/index.js";
import {
  baseRequest,
  brokenSseResponse,
  callItem,
  callStream,
  collect,
  created,
  errorResponse,
  fakeFetch,
  frame,
  messageItem,
  reasoningItem,
  refusalItem,
  sseResponse,
  terminal,
  textStream,
  wireResponse,
  wireUsage,
} from "./helpers.js";

const idle = new AbortController().signal;

function completeOf(events: readonly ProviderEvent[]): AssistantMessage {
  const last = events.at(-1);
  if (last?.type !== "complete") {
    throw new Error("missing complete event");
  }
  return last.message;
}

async function run(response: () => Response, request = baseRequest()): Promise<ProviderEvent[]> {
  const { fetch } = fakeFetch(response);
  const provider = createGrokProvider({ apiKey: "k", fetch, maxRetries: 0 });
  return collect(provider.stream(request, idle));
}

async function failure(response: () => Response, signal: AbortSignal = idle): Promise<ProviderError> {
  const { fetch } = fakeFetch(response);
  const provider = createGrokProvider({ apiKey: "k", fetch, maxRetries: 0 });
  try {
    await collect(provider.stream(baseRequest(), signal));
  } catch (error) {
    if (error instanceof ProviderError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a provider error");
}

describe("grok stream mapping", () => {
  it("maps text, usage and cost estimate", async () => {
    const events = await run(() =>
      sseResponse([
        created(),
        ...textStream(["Hel", "lo"]),
        terminal(
          "response.completed",
          wireResponse({
            output: [messageItem("Hello")],
            usage: wireUsage({ input: 32, cached: 8, output: 9, reasoning: 110, total: 151 }),
          }),
        ),
      ]),
    );
    expect(events.filter((event) => event.type === "text-delta")).toEqual([
      { type: "text-delta", text: "Hel" },
      { type: "text-delta", text: "lo" },
    ]);
    const message = completeOf(events);
    expect(message.parts).toEqual([{ type: "text", text: "Hello" }]);
    expect(message.stopReason).toBe("end");
    expect(message.provider).toBe("grok");
    expect(message.usage).toMatchObject({
      promptTokens: 32,
      inputTokens: 24,
      cacheReadTokens: 8,
      cacheWriteTokens: 0,
      outputTokens: 119,
      reasoningTokens: 110,
      model: "grok-4.7",
      costSource: "estimated",
    });
    expect(message.usage.costUsd).toBeCloseTo(0.000766, 9);
  });

  it("uses the exact cost reported by the api", async () => {
    const events = await run(() =>
      sseResponse([
        created(),
        ...textStream(["x"]),
        terminal("response.completed", wireResponse({ output: [messageItem("x")], usage: wireUsage({ costTicks: 5_000_000 }) })),
      ]),
    );
    expect(completeOf(events).usage).toMatchObject({ costSource: "exact", costUsd: 0.0005 });
  });

  it("maps reasoning and parallel tool calls", async () => {
    const events = await run(() =>
      sseResponse([
        created(),
        frame({ type: "response.reasoning_text.delta", output_index: 0, delta: "think" }),
        ...callStream(1, "call_a", "echo", ['{"te', 'xt":"a"}']),
        ...callStream(2, "call_b", "echo", ['{"text":"b"}']),
        terminal(
          "response.completed",
          wireResponse({
            output: [
              reasoningItem("think"),
              callItem("call_a", "echo", '{"text":"a"}'),
              callItem("call_b", "echo", '{"text":"b"}'),
            ],
          }),
        ),
      ]),
    );
    expect(events.filter((event) => event.type === "reasoning-delta")).toEqual([{ type: "reasoning-delta", text: "think" }]);
    expect(events.filter((event) => event.type === "tool-call-delta")).toEqual([
      { type: "tool-call-delta", id: "call_a", name: "echo", inputDelta: "" },
      { type: "tool-call-delta", id: "call_a", inputDelta: '{"te' },
      { type: "tool-call-delta", id: "call_a", inputDelta: 'xt":"a"}' },
      { type: "tool-call-delta", id: "call_b", name: "echo", inputDelta: "" },
      { type: "tool-call-delta", id: "call_b", inputDelta: '{"text":"b"}' },
    ]);
    const message = completeOf(events);
    expect(message.stopReason).toBe("tool-calls");
    expect(message.parts[0]).toEqual({ type: "reasoning", text: "think" });
    expect(toolCalls(message).map((call) => [call.id, call.input])).toEqual([
      ["call_a", { text: "a" }],
      ["call_b", { text: "b" }],
    ]);
  });

  it("flags corrupt tool arguments", async () => {
    const events = await run(() =>
      sseResponse([created(), ...callStream(0, "call_x", "echo", ['{"te']), terminal("response.completed", wireResponse({ output: [callItem("call_x", "echo", '{"te')] }))]),
    );
    const [call] = toolCalls(completeOf(events));
    expect(call).toMatchObject({ id: "call_x", input: {}, inputError: "invalid-json" });
  });

  it("treats empty arguments as an empty object", async () => {
    const events = await run(() =>
      sseResponse([created(), ...callStream(0, "call_x", "echo", []), terminal("response.completed", wireResponse({ output: [callItem("call_x", "echo", "")] }))]),
    );
    const [call] = toolCalls(completeOf(events));
    expect(call?.input).toEqual({});
    expect(call).not.toHaveProperty("inputError");
  });

  it("maps a refusal content part", async () => {
    const events = await run(() =>
      sseResponse([created(), ...textStream(["no"]), terminal("response.completed", wireResponse({ output: [refusalItem("cannot help")] }))]),
    );
    const message = completeOf(events);
    expect(message.stopReason).toBe("refusal");
    expect(message.parts).toEqual([{ type: "text", text: "cannot help" }]);
  });

  it.each([
    ["max_output_tokens", "max-tokens"],
    ["max_prompt_tokens", "context-exceeded"],
    ["content_filter", "refusal"],
    ["max_time_limit", "other"],
  ] as const)("maps incomplete reason %s", async (reason, expected) => {
    const events = await run(() =>
      sseResponse([created(), ...textStream(["a"]), terminal("response.incomplete", wireResponse({ status: "incomplete", incomplete: reason, output: [messageItem("a")] }))]),
    );
    expect(completeOf(events).stopReason).toBe(expected);
  });

  it("drops truncated function calls from an incomplete response", async () => {
    const events = await run(() =>
      sseResponse([
        created(),
        ...callStream(0, "call_t", "echo", ['{"te']),
        terminal(
          "response.incomplete",
          wireResponse({ status: "incomplete", incomplete: "max_output_tokens", output: [callItem("call_t", "echo", '{"te')] }),
        ),
      ]),
    );
    const message = completeOf(events);
    expect(message.stopReason).toBe("max-tokens");
    expect(toolCalls(message)).toEqual([]);
    expect(message.native.payload).toEqual([]);
  });

  it("surfaces server tools", async () => {
    const events = await run(() =>
      sseResponse([
        created(),
        frame({ type: "response.output_item.added", output_index: 0, item: { id: "ws_1", type: "web_search_call", status: "in_progress" } }),
        frame({ type: "response.output_item.done", output_index: 0, item: { id: "ws_1", type: "web_search_call", status: "completed" } }),
        ...textStream(["ok"], 1),
        terminal("response.completed", wireResponse({ output: [{ id: "ws_1", type: "web_search_call", status: "completed" }, messageItem("ok")] })),
      ]),
    );
    expect(events.filter((event) => event.type === "server-tool")).toEqual([
      { type: "server-tool", name: "web_search_call", status: "started" },
      { type: "server-tool", name: "web_search_call", status: "completed" },
    ]);
  });

  it("replays native output verbatim on the next request", async () => {
    const { fetch, calls } = fakeFetch(() =>
      sseResponse([
        created(),
        ...textStream(["hi"]),
        terminal("response.completed", wireResponse({ output: [reasoningItem("why"), messageItem("hi")] })),
      ]),
    );
    const provider = createGrokProvider({ apiKey: "k", fetch, maxRetries: 0 });
    const first = completeOf(await collect(provider.stream(baseRequest(), idle)));
    const payload = first.native.payload as unknown[];
    expect(JSON.stringify(payload)).toContain("enc-1");
    await collect(
      provider.stream(
        baseRequest({
          history: [
            { role: "user", parts: [{ type: "text", text: "hello" }] },
            first,
            { role: "user", parts: [{ type: "text", text: "again" }] },
          ],
        }),
        idle,
      ),
    );
    const input = (calls[1]?.body as { input: unknown[] }).input;
    expect(input).toEqual([{ role: "user", content: "hello" }, ...payload, { role: "user", content: "again" }]);
  });
});

describe("grok failures", () => {
  it("maps a failed response", async () => {
    const error = await failure(() =>
      sseResponse([created(), terminal("response.failed", wireResponse({ status: "failed", error: { code: "server_error", message: "boom" } }))]),
    );
    expect(error).toMatchObject({ kind: "server", retryable: true });
    expect(error.message).toContain("boom");
  });

  it.each([
    [401, "auth"],
    [402, "quota"],
    [403, "permission"],
    [404, "permission"],
    [400, "invalid-request"],
    [422, "invalid-request"],
    [429, "rate-limit"],
    [500, "server"],
    [503, "server"],
    [529, "overloaded"],
  ] as const)("maps http %i to %s", async (status, kind) => {
    const error = await failure(() => errorResponse(status, { error: { message: "nope" } }));
    expect(error.kind).toBe(kind);
    expect(error.status).toBe(status);
    expect(error.requestId).toBe("req_err");
  });

  it("classifies a rejected fetch as network", async () => {
    const provider = createGrokProvider({
      apiKey: "k",
      fetch: (() => Promise.reject(new TypeError("fetch failed"))),
      maxRetries: 0,
    });
    await expect(collect(provider.stream(baseRequest(), idle))).rejects.toMatchObject({ kind: "network" });
  });

  it("classifies a socket reset after output as stream-interrupted", async () => {
    const error = await failure(() => brokenSseResponse([created(), ...textStream(["partial"])]));
    expect(error).toMatchObject({ kind: "stream-interrupted", retryable: true });
  });

  it("classifies a stream closed before the terminal event as stream-interrupted", async () => {
    const error = await failure(() => sseResponse([created(), ...textStream(["partial"])]));
    expect(error.kind).toBe("stream-interrupted");
  });

  it("classifies an sse error event after output as stream-interrupted", async () => {
    const error = await failure(() =>
      sseResponse([created(), ...textStream(["partial"]), frame({ type: "error", code: "server_error", message: "boom" })]),
    );
    expect(error.kind).toBe("stream-interrupted");
  });

  it("classifies an abort before the request", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await failure(() => sseResponse([]), controller.signal);
    expect(error.kind).toBe("aborted");
  });

  it("classifies an abort during streaming", async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();
    const hanging = (): Response =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(encoder.encode([created(), ...textStream(["a"])].join("")));
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    const { fetch } = fakeFetch(hanging);
    const provider = createGrokProvider({ apiKey: "k", fetch, maxRetries: 0 });
    let caught: unknown;
    try {
      for await (const event of provider.stream(baseRequest(), controller.signal)) {
        if (event.type === "text-delta") {
          controller.abort();
        }
      }
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ kind: "aborted", retryable: false });
  });
});
