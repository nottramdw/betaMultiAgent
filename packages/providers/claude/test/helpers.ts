import type { ProviderEvent, ProviderRequest } from "@betamultiagent/core";

export interface RecordedCall {
  readonly url: string;
  readonly headers: Headers;
  readonly body: unknown;
}

export type FetchHandler = (call: RecordedCall, index: number) => Response;

export function fakeFetch(handler: FetchHandler): { fetch: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const impl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const raw = init?.body;
    const body: unknown = typeof raw === "string" ? JSON.parse(raw) : undefined;
    const call: RecordedCall = {
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      headers: new Headers(init?.headers),
      body,
    };
    calls.push(call);
    return Promise.resolve(handler(call, calls.length - 1));
  };
  return { fetch: impl, calls };
}

export function frame(event: { readonly type: string; readonly [key: string]: unknown }): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

const encoder = new TextEncoder();

export function sseResponse(frames: readonly string[], extraHeaders: Record<string, string> = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frames.join("")));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream", "request-id": "req_test", ...extraHeaders },
  });
}

export function brokenSseResponse(frames: readonly string[]): Response {
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (pulls === 1) {
        controller.enqueue(encoder.encode(frames.join("")));
        return;
      }
      controller.error(new Error("socket reset"));
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream", "request-id": "req_test" },
  });
}

export function errorResponse(status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "request-id": "req_err", "x-should-retry": "false", ...extraHeaders },
  });
}

export async function collect(iterable: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

export function baseRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: "claude-sonnet-5-5",
    system: "You are a test agent.",
    tools: [],
    history: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
    maxOutputTokens: 1024,
    toolChoice: "auto",
    cacheKey: "session-1",
    ...overrides,
  };
}

export interface MessageStartInit {
  readonly model?: string;
  readonly input?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly output?: number;
}

export function messageStart(init: MessageStartInit = {}): { readonly type: "message_start" } {
  return {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: init.model ?? "claude-sonnet-5-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      stop_details: null,
      container: null,
      diagnostics: null,
      usage: {
        input_tokens: init.input ?? 10,
        cache_creation_input_tokens: init.cacheWrite ?? 0,
        cache_read_input_tokens: init.cacheRead ?? 0,
        output_tokens: init.output ?? 1,
      },
    },
  } as { readonly type: "message_start" };
}

export interface MessageDeltaInit {
  readonly stopReason: string;
  readonly output?: number;
  readonly stopDetails?: { readonly category: string | null; readonly explanation: string | null; readonly type: "refusal" };
}

export function messageDelta(init: MessageDeltaInit): { readonly type: "message_delta" } {
  return {
    type: "message_delta",
    delta: {
      container: null,
      stop_details: init.stopDetails ?? null,
      stop_reason: init.stopReason,
      stop_sequence: null,
    },
    usage: {
      input_tokens: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      output_tokens: init.output ?? 5,
      output_tokens_details: null,
      server_tool_use: null,
    },
  } as { readonly type: "message_delta" };
}

export function textBlock(index: number, pieces: readonly string[]): string[] {
  return [
    frame({ type: "content_block_start", index, content_block: { type: "text", text: "", citations: null } }),
    ...pieces.map((text) =>
      frame({ type: "content_block_delta", index, delta: { type: "text_delta", text } }),
    ),
    frame({ type: "content_block_stop", index }),
  ];
}

export function toolBlock(index: number, id: string, name: string, jsonPieces: readonly string[]): string[] {
  return [
    frame({
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id, name, input: {}, caller: { type: "direct" } },
    }),
    ...jsonPieces.map((partial_json) =>
      frame({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json } }),
    ),
    frame({ type: "content_block_stop", index }),
  ];
}

export function thinkingBlock(index: number, thinking: string, signature: string): string[] {
  return [
    frame({
      type: "content_block_start",
      index,
      content_block: { type: "thinking", thinking: "", signature: "" },
    }),
    frame({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking } }),
    frame({ type: "content_block_delta", index, delta: { type: "signature_delta", signature } }),
    frame({ type: "content_block_stop", index }),
  ];
}
