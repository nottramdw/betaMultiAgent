import type { ProviderEvent, ProviderRequest } from "@betamultiagent/core";

export interface RecordedCall {
  readonly url: string;
  readonly headers: Headers;
  readonly body: unknown;
}

export type FetchHandler = (call: RecordedCall, index: number) => Response;

export function fakeFetch(handler: FetchHandler): { fetch: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const text = await request.clone().text();
    const call: RecordedCall = {
      url: request.url,
      headers: new Headers(request.headers),
      body: text.length > 0 ? (JSON.parse(text) as unknown) : undefined,
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { fetch: impl, calls };
}

export function frame(event: { readonly type: string; readonly [key: string]: unknown }): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

const encoder = new TextEncoder();

export function sseResponse(frames: readonly string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frames.join("")));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream", "x-request-id": "req_test" },
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
    headers: { "content-type": "text/event-stream", "x-request-id": "req_test" },
  });
}

export function errorResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-request-id": "req_err" },
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
    model: "grok-4.7",
    system: "You are a test agent.",
    tools: [],
    history: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
    maxOutputTokens: 1024,
    toolChoice: "auto",
    cacheKey: "session-1",
    ...overrides,
  };
}

export interface UsageInit {
  readonly input?: number;
  readonly cached?: number;
  readonly output?: number;
  readonly reasoning?: number;
  readonly total?: number;
  readonly costTicks?: number;
}

export function wireUsage(init: UsageInit = {}): Record<string, unknown> {
  const input = init.input ?? 10;
  const output = init.output ?? 5;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: init.total ?? input + output,
    input_tokens_details: { cached_tokens: init.cached ?? 0 },
    output_tokens_details: { reasoning_tokens: init.reasoning ?? 0 },
    ...(init.costTicks === undefined ? {} : { cost_in_usd_ticks: init.costTicks }),
  };
}

export interface ResponseInit {
  readonly status?: string;
  readonly output?: readonly unknown[];
  readonly usage?: Record<string, unknown>;
  readonly model?: string;
  readonly incomplete?: string;
  readonly error?: unknown;
}

export function wireResponse(init: ResponseInit = {}): Record<string, unknown> {
  return {
    id: "resp_1",
    object: "response",
    status: init.status ?? "completed",
    model: init.model ?? "grok-4.7",
    output: init.output ?? [],
    usage: init.usage ?? wireUsage(),
    incomplete_details: init.incomplete === undefined ? null : { reason: init.incomplete },
    ...(init.error === undefined ? {} : { error: init.error }),
  };
}

export function messageItem(text: string, id = "msg_1"): Record<string, unknown> {
  return {
    id,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

export function refusalItem(refusal: string): Record<string, unknown> {
  return {
    id: "msg_r",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "refusal", refusal }],
  };
}

export function reasoningItem(text: string, id = "rs_1"): Record<string, unknown> {
  return {
    id,
    type: "reasoning",
    status: "completed",
    summary: [],
    content: [{ type: "reasoning_text", text }],
    encrypted_content: "enc-1",
  };
}

export function callItem(callId: string, name: string, args: string, id = `fc_${callId}`): Record<string, unknown> {
  return { id, type: "function_call", status: "completed", call_id: callId, name, arguments: args };
}

export function terminal(type: "response.completed" | "response.failed" | "response.incomplete", response: Record<string, unknown>): string {
  return frame({ type, response });
}

export function created(): string {
  return frame({ type: "response.created", response: wireResponse({ status: "in_progress" }) });
}

export function textStream(pieces: readonly string[], index = 0): string[] {
  return [
    frame({ type: "response.output_item.added", output_index: index, item: { ...messageItem(""), status: "in_progress", content: [] } }),
    ...pieces.map((delta) => frame({ type: "response.output_text.delta", output_index: index, item_id: "msg_1", content_index: 0, delta })),
  ];
}

export function callStream(index: number, callId: string, name: string, pieces: readonly string[]): string[] {
  const item = { ...callItem(callId, name, ""), status: "in_progress" };
  return [
    frame({ type: "response.output_item.added", output_index: index, item }),
    ...pieces.map((delta) =>
      frame({ type: "response.function_call_arguments.delta", output_index: index, item_id: `fc_${callId}`, delta }),
    ),
  ];
}
