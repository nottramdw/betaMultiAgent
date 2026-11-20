import { z } from "zod";
import { TurnOutcomeSchema } from "../agent/agent-spec.js";
import { MessageSchema } from "../messages/messages.js";
import { PermissionRequestSchema } from "../permissions/permission-types.js";
import type { ProviderEvent } from "../provider/provider.js";
import { UsageSchema } from "../usage/usage.js";
import { PROTOCOL_VERSION } from "./protocol-version.js";

export const EventBodySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session-start"),
    sessionId: z.string().min(1),
    agentName: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    cwd: z.string().min(1),
  }),
  z.object({ type: z.literal("message"), message: MessageSchema }),
  z.object({ type: z.literal("tool-start"), toolCallId: z.string().min(1), name: z.string().min(1), input: z.unknown() }),
  z.object({
    type: z.literal("tool-end"),
    toolCallId: z.string().min(1),
    name: z.string().min(1),
    isError: z.boolean(),
    durationMs: z.number().nonnegative(),
    promptText: z.string(),
  }),
  z.object({
    type: z.literal("permission"),
    request: PermissionRequestSchema,
    allowed: z.boolean(),
    source: z.enum(["hard-deny", "rule", "session", "default", "fallback"]),
    reason: z.string(),
    sensitive: z.boolean(),
    approval: z.enum(["allow-once", "allow-session", "deny"]).optional(),
  }),
  z.object({ type: z.literal("usage"), agentName: z.string().min(1), usage: UsageSchema }),
  z.object({
    type: z.literal("compaction"),
    trigger: z.enum(["threshold", "context-exceeded"]),
    replacedMessages: z.number().int().nonnegative(),
    summaryChars: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("context-loaded"), sources: z.array(z.string().min(1)) }),
  z.object({ type: z.literal("outcome"), outcome: TurnOutcomeSchema }),
  z.object({ type: z.literal("error"), code: z.string().min(1), message: z.string() }),
  z.object({ type: z.literal("team-phase"), phase: z.string().min(1), detail: z.string().optional() }),
]);
export type EventBody = z.infer<typeof EventBodySchema>;
export type EventType = EventBody["type"];

export const RecordHeaderSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  seq: z.number().int().positive(),
  ts: z.iso.datetime(),
});
export type RecordHeader = z.infer<typeof RecordHeaderSchema>;

export const EventRecordSchema = z.intersection(RecordHeaderSchema, EventBodySchema);
export type EventRecord = RecordHeader & EventBody;

export type StreamDelta = Exclude<ProviderEvent, { type: "complete" }>;

export interface EventListener {
  onRecord?(record: EventRecord): void;
  onDelta?(delta: StreamDelta): void;
}

export interface EventSink {
  append(body: EventBody): Promise<EventRecord>;
}

export class InMemoryEventSink implements EventSink {
  readonly records: EventRecord[] = [];
  readonly #now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  append(body: EventBody): Promise<EventRecord> {
    const record: EventRecord = {
      v: PROTOCOL_VERSION,
      seq: this.records.length + 1,
      ts: this.#now().toISOString(),
      ...EventBodySchema.parse(body),
    };
    this.records.push(record);
    return Promise.resolve(record);
  }
}
