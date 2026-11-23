import { defineTool, type ToolDefinition, type ToolResult } from "@betamultiagent/core";
import { z } from "zod";
import { MAX_MEMORY_TEXT, MemoryLimitError, type MemoryStore } from "./memory-store.js";

export const MEMORY_PROPOSE = "memory_propose";

const MemoryProposeInputSchema = z.strictObject({
  text: z.string().trim().min(1).max(MAX_MEMORY_TEXT).describe("One durable fact about this workspace, written so it is useful without the current task."),
  reason: z.string().trim().max(MAX_MEMORY_TEXT).optional().describe("What you observed that makes the fact true."),
});
type MemoryProposeInput = z.infer<typeof MemoryProposeInputSchema>;

interface MemoryProposeOutput {
  readonly id?: string;
  readonly status: "pending" | "rejected";
  readonly message?: string;
}

export function createMemoryProposeTool(store: MemoryStore): ToolDefinition<MemoryProposeInput, MemoryProposeOutput> {
  return defineTool({
    name: MEMORY_PROPOSE,
    description:
      "Propose one durable fact about this workspace for later sessions, such as a build or test command, a convention, or a pitfall you confirmed. The user reviews every proposal; nothing is remembered until the user approves it. Do not propose secrets, personal data, or details that only matter to the current task.",
    input: MemoryProposeInputSchema,
    capabilities: { readOnly: true, maxConcurrency: 1 },
    permission: () => ({ kind: "none" }),
    execute: async (input, context): Promise<ToolResult<MemoryProposeOutput>> => {
      try {
        const entry = await store.propose({
          text: input.text,
          ...(input.reason === undefined || input.reason.length === 0 ? {} : { reason: input.reason }),
          source: { agent: context.agentName, sessionId: context.sessionId },
        });
        return { output: { id: entry.id, status: "pending" }, promptText: `memory proposal ${entry.id} recorded; it waits for the user's review`, isError: false };
      } catch (error) {
        if (error instanceof MemoryLimitError) {
          return { output: { status: "rejected", message: error.message }, promptText: `memory proposal not recorded: ${error.message}`, isError: true };
        }
        throw error;
      }
    },
  });
}
