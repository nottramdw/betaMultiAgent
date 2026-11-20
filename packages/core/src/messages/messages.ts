import { z } from "zod";
import { UsageSchema } from "../usage/usage.js";

export const ProviderIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/u);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const SyntheticReasonSchema = z.enum([
  "project-context",
  "context-update",
  "loop-nudge",
  "completion-reminder",
  "budget-warning",
  "compaction",
  "handoff",
]);
export type SyntheticReason = z.infer<typeof SyntheticReasonSchema>;

export const StopReasonSchema = z.enum(["end", "tool-calls", "max-tokens", "refusal", "pause", "context-exceeded", "other"]);
export type StopReason = z.infer<typeof StopReasonSchema>;

export const TextPartSchema = z.object({ type: z.literal("text"), text: z.string() });
export type TextPart = z.infer<typeof TextPartSchema>;

export const ToolResultPartSchema = z.object({
  type: z.literal("tool-result"),
  toolCallId: z.string().min(1),
  content: z.string(),
  isError: z.boolean(),
});
export type ToolResultPart = z.infer<typeof ToolResultPartSchema>;

export const ToolCallPartSchema = z.object({
  type: z.literal("tool-call"),
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.unknown(),
  inputError: z.literal("invalid-json").optional(),
});
export type ToolCallPart = z.infer<typeof ToolCallPartSchema>;

export const ReasoningPartSchema = z.object({ type: z.literal("reasoning"), text: z.string() });
export type ReasoningPart = z.infer<typeof ReasoningPartSchema>;

export const NativeTurnSchema = z.object({ provider: ProviderIdSchema, payload: z.unknown() });
export type NativeTurn = z.infer<typeof NativeTurnSchema>;

export const StopDetailsSchema = z.object({
  category: z.string().nullable(),
  explanation: z.string().optional(),
  recommendedModel: z.string().nullable().optional(),
});
export type StopDetails = z.infer<typeof StopDetailsSchema>;

export const UserMessageSchema = z.object({
  role: z.literal("user"),
  parts: z.array(z.discriminatedUnion("type", [TextPartSchema, ToolResultPartSchema])),
  synthetic: SyntheticReasonSchema.optional(),
});
export type UserMessage = z.infer<typeof UserMessageSchema>;

export const AssistantMessageSchema = z.object({
  role: z.literal("assistant"),
  parts: z.array(z.discriminatedUnion("type", [TextPartSchema, ToolCallPartSchema, ReasoningPartSchema])),
  native: NativeTurnSchema,
  provider: ProviderIdSchema,
  model: z.string().min(1),
  stopReason: StopReasonSchema,
  stopDetails: StopDetailsSchema.optional(),
  usage: UsageSchema,
});
export type AssistantMessage = z.infer<typeof AssistantMessageSchema>;

export const SystemNoteSchema = z.object({
  role: z.literal("system"),
  text: z.string(),
  reason: SyntheticReasonSchema,
});
export type SystemNote = z.infer<typeof SystemNoteSchema>;

export const MessageSchema = z.discriminatedUnion("role", [UserMessageSchema, AssistantMessageSchema, SystemNoteSchema]);
export type Message = z.infer<typeof MessageSchema>;

export function toolCalls(message: AssistantMessage): ToolCallPart[] {
  return message.parts.filter((part): part is ToolCallPart => part.type === "tool-call");
}

export function textOf(message: AssistantMessage | UserMessage): string {
  return message.parts
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => part.text)
    .join("");
}
