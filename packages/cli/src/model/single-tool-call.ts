import { toolCalls, toToolSpec, type AssistantMessage, type ModelInfo, type Provider } from "@betamultiagent/core";
import type { z } from "zod";

export interface ModelTarget {
  readonly provider: Provider;
  readonly model: ModelInfo;
}

export interface SingleToolCallRequest<T> {
  readonly system: string;
  readonly prompt: string;
  readonly toolName: string;
  readonly toolDescription: string;
  readonly schema: z.ZodType<T>;
  readonly maxOutputTokens: number;
  readonly cacheKey: string;
}

export type SingleToolCallResult<T> =
  | { readonly ok: true; readonly value: T; readonly costUsd: number }
  | { readonly ok: false; readonly problem: string; readonly costUsd: number };

export async function requestToolCall<T>(target: ModelTarget, request: SingleToolCallRequest<T>, signal: AbortSignal): Promise<SingleToolCallResult<T>> {
  let message: AssistantMessage | undefined;
  const stream = target.provider.stream(
    {
      model: target.model.id,
      system: request.system,
      tools: [toToolSpec({ name: request.toolName, description: request.toolDescription, input: request.schema })],
      history: [{ role: "user", parts: [{ type: "text", text: request.prompt }] }],
      maxOutputTokens: Math.min(request.maxOutputTokens, target.model.maxOutput),
      toolChoice: "auto",
      cacheKey: request.cacheKey,
    },
    signal,
  );
  for await (const event of stream) {
    if (event.type === "complete") {
      message = event.message;
    }
  }
  if (message === undefined) {
    return { ok: false, problem: "the stream ended without a message", costUsd: 0 };
  }
  const costUsd = message.usage.costUsd ?? 0;
  const call = toolCalls(message).find((part) => part.name === request.toolName);
  if (call === undefined) {
    return { ok: false, problem: `no ${request.toolName} call (stop reason ${message.stopReason})`, costUsd };
  }
  const parsed = request.schema.safeParse(call.input);
  if (!parsed.success) {
    return { ok: false, problem: parsed.error.issues.map((issue) => issue.message).join("; "), costUsd };
  }
  return { ok: true, value: parsed.data, costUsd };
}
