import { toolCalls, type AssistantMessage, type Message, type ProviderEvent, type ToolSpec } from "@betamultiagent/core";
import { describe, expect, it } from "vitest";
import { createGrokProvider } from "../../src/index.js";

const live = process.env["BMA_LIVE_TESTS"] === "1";

const echo: ToolSpec = {
  name: "echo",
  description: "Returns the given text unchanged.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
};

async function lastMessage(events: AsyncIterable<ProviderEvent>): Promise<AssistantMessage> {
  let message: AssistantMessage | undefined;
  for await (const event of events) {
    if (event.type === "complete") {
      message = event.message;
    }
  }
  if (message === undefined) {
    throw new Error("stream ended without a complete event");
  }
  return message;
}

describe.skipIf(!live)("grok live smoke", () => {
  it("replays tool turns across three requests", { timeout: 120_000 }, async () => {
    const apiKey = process.env["XAI_API_KEY"];
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error("XAI_API_KEY is required for live tests");
    }
    const provider = createGrokProvider({ apiKey });
    const history: Message[] = [
      { role: "user", parts: [{ type: "text", text: "Call the echo tool with the text ping, then reply with the word done." }] },
    ];
    const signal = new AbortController().signal;
    let finalStop = "";
    for (let turn = 0; turn < 3; turn += 1) {
      const message = await lastMessage(
        provider.stream(
          {
            model: "grok-4.3",
            system: "You are a terse test agent.",
            tools: [echo],
            history,
            maxOutputTokens: 2048,
            toolChoice: "auto",
            cacheKey: "live-smoke",
          },
          signal,
        ),
      );
      history.push(message);
      expect(message.usage.promptTokens).toBeGreaterThan(0);
      finalStop = message.stopReason;
      const calls = toolCalls(message);
      if (calls.length === 0) {
        break;
      }
      history.push({
        role: "user",
        parts: calls.map((call) => ({ type: "tool-result" as const, toolCallId: call.id, content: "ping", isError: false })),
      });
    }
    expect(finalStop).toBe("end");
  });
});
