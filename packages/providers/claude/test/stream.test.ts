import { ProviderError, textOf, toolCalls, type AssistantMessage, type ProviderEvent } from "@betamultiagent/core";
import { describe, expect, it } from "vitest";
import { createClaudeProvider } from "../src/index.js";
import {
  baseRequest,
  brokenSseResponse,
  collect,
  errorResponse,
  fakeFetch,
  frame,
  messageDelta,
  messageStart,
  sseResponse,
  textBlock,
  thinkingBlock,
  toolBlock,
  type FetchHandler,
} from "./helpers.js";

const STOP = frame({ type: "message_stop" });

function providerFor(handler: FetchHandler) {
  const { fetch, calls } = fakeFetch(handler);
  const provider = createClaudeProvider({ apiKey: "test-key", fetch, maxRetries: 0 });
  return { provider, calls };
}

function complete(events: readonly ProviderEvent[]): AssistantMessage {
  const last = events.at(-1);
  if (last?.type !== "complete") {
    throw new Error("stream did not complete");
  }
  return last.message;
}

async function failure(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProviderError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the stream to fail");
}

const idle = new AbortController().signal;

describe("claude streaming", () => {
  it("streams text and maps usage with cache accounting", async () => {
    const { provider, calls } = providerFor(() =>
      sseResponse([
        frame(messageStart({ input: 10, cacheRead: 5, cacheWrite: 3 })),
        ...textBlock(0, ["Hel", "lo"]),
        frame(messageDelta({ stopReason: "end_turn", output: 7 })),
        STOP,
      ]),
    );
    const events = await collect(provider.stream(baseRequest(), idle));
    expect(events.filter((event) => event.type === "text-delta").map((event) => event.text)).toEqual(["Hel", "lo"]);
    const message = complete(events);
    expect(textOf(message)).toBe("Hello");
    expect(message.stopReason).toBe("end");
    expect(message.provider).toBe("claude");
    expect(message.native.provider).toBe("claude");
    expect(message.usage).toMatchObject({
      promptTokens: 18,
      inputTokens: 10,
      cacheReadTokens: 5,
      cacheWriteTokens: 3,
      outputTokens: 7,
      costSource: "estimated",
      model: "claude-sonnet-5-5",
    });
    expect(message.usage.costUsd).toBeCloseTo(0.000098, 9);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toMatchObject({ stream: true, model: "claude-sonnet-5-5" });
  });

  it("emits reasoning and parallel tool calls in block order", async () => {
    const { provider } = providerFor(() =>
      sseResponse([
        frame(messageStart()),
        ...thinkingBlock(0, "think", "sig-1"),
        ...toolBlock(1, "toolu_a", "read_file", ['{"path":', '"a.ts"}']),
        ...toolBlock(2, "toolu_b", "read_file", ['{"path":"b.ts"}']),
        frame(messageDelta({ stopReason: "tool_use" })),
        STOP,
      ]),
    );
    const events = await collect(provider.stream(baseRequest(), idle));
    expect(events.filter((event) => event.type === "reasoning-delta")).toEqual([{ type: "reasoning-delta", text: "think" }]);
    const deltas = events.filter((event) => event.type === "tool-call-delta");
    expect(deltas[0]).toEqual({ type: "tool-call-delta", id: "toolu_a", name: "read_file", inputDelta: "" });
    expect(deltas[1]).toEqual({ type: "tool-call-delta", id: "toolu_a", inputDelta: '{"path":' });
    const message = complete(events);
    expect(message.stopReason).toBe("tool-calls");
    expect(message.parts.map((part) => part.type)).toEqual(["reasoning", "tool-call", "tool-call"]);
    expect(toolCalls(message)).toEqual([
      { type: "tool-call", id: "toolu_a", name: "read_file", input: { path: "a.ts" } },
      { type: "tool-call", id: "toolu_b", name: "read_file", input: { path: "b.ts" } },
    ]);
  });

  it("maps pause_turn to pause", async () => {
    const { provider } = providerFor(() =>
      sseResponse([frame(messageStart()), ...textBlock(0, ["partial"]), frame(messageDelta({ stopReason: "pause_turn" })), STOP]),
    );
    expect(complete(await collect(provider.stream(baseRequest(), idle))).stopReason).toBe("pause");
  });

  it("maps a refusal with stop details", async () => {
    const { provider } = providerFor(() =>
      sseResponse([
        frame(messageStart()),
        frame(
          messageDelta({
            stopReason: "refusal",
            stopDetails: { type: "refusal", category: "cyber", explanation: "not allowed" },
          }),
        ),
        STOP,
      ]),
    );
    const message = complete(await collect(provider.stream(baseRequest(), idle)));
    expect(message.stopReason).toBe("refusal");
    expect(message.stopDetails).toEqual({ category: "cyber", explanation: "not allowed" });
  });

  it("maps a refusal without an explanation", async () => {
    const { provider } = providerFor(() =>
      sseResponse([
        frame(messageStart()),
        frame(messageDelta({ stopReason: "refusal", stopDetails: { type: "refusal", category: null, explanation: null } })),
        STOP,
      ]),
    );
    const message = complete(await collect(provider.stream(baseRequest(), idle)));
    expect(message.stopDetails).toEqual({ category: null });
  });

  it("maps max_tokens with a dangling tool call to invalid-json", async () => {
    const { provider } = providerFor(() =>
      sseResponse([
        frame(messageStart()),
        ...toolBlock(0, "toolu_x", "read_file", ['{"path":"a']),
        frame(messageDelta({ stopReason: "max_tokens" })),
        STOP,
      ]),
    );
    const message = complete(await collect(provider.stream(baseRequest(), idle)));
    expect(message.stopReason).toBe("max-tokens");
    expect(toolCalls(message)).toEqual([
      { type: "tool-call", id: "toolu_x", name: "read_file", input: {}, inputError: "invalid-json" },
    ]);
  });

  it("finalizes a tool call whose block never closed", async () => {
    const { provider } = providerFor(() =>
      sseResponse([
        frame(messageStart()),
        frame({
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_y", name: "read_file", input: {} },
        }),
        frame({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } }),
        frame(messageDelta({ stopReason: "tool_use" })),
        STOP,
      ]),
    );
    const message = complete(await collect(provider.stream(baseRequest(), idle)));
    expect(toolCalls(message)).toEqual([{ type: "tool-call", id: "toolu_y", name: "read_file", input: {} }]);
  });

  it("maps model_context_window_exceeded", async () => {
    const { provider } = providerFor(() =>
      sseResponse([frame(messageStart()), frame(messageDelta({ stopReason: "model_context_window_exceeded" })), STOP]),
    );
    expect(complete(await collect(provider.stream(baseRequest(), idle))).stopReason).toBe("context-exceeded");
  });

  it("uses the response model for usage", async () => {
    const { provider } = providerFor(() =>
      sseResponse([
        frame(messageStart({ model: "claude-sonnet-5-5-20261101" })),
        ...textBlock(0, ["x"]),
        frame(messageDelta({ stopReason: "end_turn" })),
        STOP,
      ]),
    );
    const message = complete(await collect(provider.stream(baseRequest(), idle)));
    expect(message.model).toBe("claude-sonnet-5-5-20261101");
    expect(message.usage.model).toBe("claude-sonnet-5-5-20261101");
    expect(message.usage.costSource).toBe("estimated");
  });

  it("replays the previous turn content verbatim on the next request", async () => {
    let turn = 0;
    const { provider, calls } = providerFor(() => {
      turn += 1;
      return turn === 1
        ? sseResponse([
            frame(messageStart()),
            ...thinkingBlock(0, "plan", "sig-1"),
            ...textBlock(1, ["checking"]),
            ...toolBlock(2, "toolu_1", "read_file", ['{"path":"a.ts"}']),
            frame(messageDelta({ stopReason: "tool_use" })),
            STOP,
          ])
        : sseResponse([frame(messageStart()), ...textBlock(0, ["done"]), frame(messageDelta({ stopReason: "end_turn" })), STOP]);
    });
    const first = complete(await collect(provider.stream(baseRequest(), idle)));
    const second = baseRequest({
      history: [
        { role: "user", parts: [{ type: "text", text: "hello" }] },
        first,
        { role: "user", parts: [{ type: "tool-result", toolCallId: "toolu_1", content: "contents", isError: false }] },
      ],
    });
    complete(await collect(provider.stream(second, idle)));
    const body = calls[1]?.body as { messages: { content: unknown }[] };
    expect(JSON.stringify(body.messages[1]?.content)).toBe(JSON.stringify(first.native.payload));
    expect(body.messages[1]?.content).toEqual([
      { type: "thinking", thinking: "plan", signature: "sig-1" },
      { type: "text", text: "checking", citations: null },
      { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.ts" }, caller: { type: "direct" } },
    ]);
  });

  it("rejects models outside the catalog before any request", async () => {
    const { provider, calls } = providerFor(() => sseResponse([]));
    const error = await failure(collect(provider.stream(baseRequest({ model: "claude-3-haiku" }), idle)));
    expect(error.kind).toBe("invalid-request");
    expect(calls).toHaveLength(0);
  });
});

describe("claude error classification", () => {
  const cases: readonly {
    readonly name: string;
    readonly status: number;
    readonly body: unknown;
    readonly kind: string;
  }[] = [
    {
      name: "401",
      status: 401,
      body: { type: "error", error: { type: "authentication_error", message: "bad key" } },
      kind: "auth",
    },
    {
      name: "403",
      status: 403,
      body: { type: "error", error: { type: "permission_error", message: "denied" } },
      kind: "permission",
    },
    {
      name: "404",
      status: 404,
      body: { type: "error", error: { type: "not_found_error", message: "no model" } },
      kind: "permission",
    },
    {
      name: "429",
      status: 429,
      body: { type: "error", error: { type: "rate_limit_error", message: "slow down" } },
      kind: "rate-limit",
    },
    {
      name: "429 spend limit",
      status: 429,
      body: {
        type: "error",
        error: {
          type: "rate_limit_error",
          message: "limit",
          details: { error_code: "enforced_spend_limit_reached" },
        },
      },
      kind: "quota",
    },
    {
      name: "400 prompt too long",
      status: 400,
      body: { type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 1200000 tokens" } },
      kind: "context-exceeded",
    },
    {
      name: "400 invalid signature",
      status: 400,
      body: { type: "error", error: { type: "invalid_request_error", message: "Invalid signature in thinking block" } },
      kind: "invalid-request",
    },
    {
      name: "413",
      status: 413,
      body: { type: "error", error: { type: "request_too_large", message: "too large" } },
      kind: "invalid-request",
    },
    {
      name: "422",
      status: 422,
      body: { type: "error", error: { type: "invalid_request_error", message: "unprocessable" } },
      kind: "invalid-request",
    },
    {
      name: "500",
      status: 500,
      body: { type: "error", error: { type: "api_error", message: "oops" } },
      kind: "server",
    },
    {
      name: "503",
      status: 503,
      body: { type: "error", error: { type: "api_error", message: "unavailable" } },
      kind: "server",
    },
    {
      name: "529",
      status: 529,
      body: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
      kind: "overloaded",
    },
  ];

  it.each(cases)("maps HTTP $name to $kind", async ({ status, body, kind }) => {
    const { provider } = providerFor(() => errorResponse(status, body));
    const error = await failure(collect(provider.stream(baseRequest(), idle)));
    expect(error.kind).toBe(kind);
    expect(error.status).toBe(status);
    expect(error.requestId).toBe("req_err");
  });

  it("marks retryable kinds as retryable", async () => {
    const { provider } = providerFor(() =>
      errorResponse(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }),
    );
    const error = await failure(collect(provider.stream(baseRequest(), idle)));
    expect(error.retryable).toBe(true);
  });

  it("maps a connection failure to network", async () => {
    const provider = createClaudeProvider({
      apiKey: "test-key",
      maxRetries: 0,
      fetch: (() => Promise.reject(new TypeError("fetch failed"))),
    });
    const error = await failure(collect(provider.stream(baseRequest(), idle)));
    expect(error.kind).toBe("network");
    expect(error.retryable).toBe(true);
  });

  it("maps an error event before the first stream event", async () => {
    const { provider } = providerFor(() =>
      sseResponse([
        'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
      ]),
    );
    const error = await failure(collect(provider.stream(baseRequest(), idle)));
    expect(error.kind).toBe("overloaded");
  });

  it("maps an error event after streaming started to stream-interrupted", async () => {
    const { provider } = providerFor(() =>
      sseResponse([
        frame(messageStart()),
        'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
      ]),
    );
    const error = await failure(collect(provider.stream(baseRequest(), idle)));
    expect(error.kind).toBe("stream-interrupted");
    expect(error.retryable).toBe(true);
  });

  it("maps a socket failure mid-stream to stream-interrupted", async () => {
    const { provider } = providerFor(() => brokenSseResponse([frame(messageStart()), ...textBlock(0, ["par"]).slice(0, 2)]));
    const error = await failure(collect(provider.stream(baseRequest(), idle)));
    expect(error.kind).toBe("stream-interrupted");
  });

  it("maps a stream that closes before message_stop to stream-interrupted", async () => {
    const { provider } = providerFor(() =>
      sseResponse([frame(messageStart()), ...textBlock(0, ["partial"]), frame(messageDelta({ stopReason: "end_turn" }))]),
    );
    const error = await failure(collect(provider.stream(baseRequest(), idle)));
    expect(error.kind).toBe("stream-interrupted");
  });

  it("maps an aborted request to aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { provider } = providerFor(() => sseResponse([]));
    const error = await failure(collect(provider.stream(baseRequest(), controller.signal)));
    expect(error.kind).toBe("aborted");
    expect(error.retryable).toBe(false);
  });

  it("maps an abort during streaming to aborted", async () => {
    const controller = new AbortController();
    const { provider } = providerFor(() =>
      sseResponse([frame(messageStart()), ...textBlock(0, ["a", "b"]), frame(messageDelta({ stopReason: "end_turn" })), STOP]),
    );
    const iterator = provider.stream(baseRequest(), controller.signal)[Symbol.asyncIterator]();
    await iterator.next();
    controller.abort();
    const error = await failure(
      (async () => {
        for (;;) {
          const step = await iterator.next();
          if (step.done === true) {
            return;
          }
        }
      })(),
    );
    expect(error.kind).toBe("aborted");
  });
});
