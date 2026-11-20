import { ProviderError, ulid, ULID_PATTERN, ulidTime, type ProviderEvent, type ProviderRequest } from "../../src/index.js";
import { ScriptedProvider, ScriptViolation } from "../../src/testing/index.js";
import { describe, expect, it } from "vitest";

const request: ProviderRequest = {
  model: "m",
  system: "s",
  tools: [],
  history: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
  maxOutputTokens: 100,
  toolChoice: "auto",
  cacheKey: "k",
};

async function drain(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe("ScriptedProvider", () => {
  it("streams deltas and a complete message", async () => {
    const provider = new ScriptedProvider([
      { respond: { parts: [{ type: "text", text: "a" }, { type: "tool-call", id: "c1", name: "t", input: { x: 1 } }] } },
    ]);
    const events = await drain(provider.stream(request, new AbortController().signal));
    expect(events.map((event) => event.type)).toEqual(["text-delta", "tool-call-delta", "complete"]);
    const last = events[events.length - 1];
    expect(last?.type === "complete" ? last.message.stopReason : undefined).toBe("tool-calls");
    provider.assertDone();
  });

  it("raises a violation when expectations fail or the script runs out", async () => {
    const provider = new ScriptedProvider([
      {
        expect: (req) => {
          if (req.toolChoice !== "none") {
            throw new Error("expected toolChoice none");
          }
        },
        respond: { text: "x" },
      },
    ]);
    await expect(drain(provider.stream(request, new AbortController().signal))).rejects.toBeInstanceOf(ScriptViolation);
    await expect(drain(provider.stream(request, new AbortController().signal))).rejects.toBeInstanceOf(ScriptViolation);
  });

  it("reports unused steps and scripted errors", async () => {
    const provider = new ScriptedProvider([
      { respond: new ProviderError("stream-interrupted", "cut") },
      { respond: { text: "unused" } },
    ]);
    await expect(drain(provider.stream(request, new AbortController().signal))).rejects.toMatchObject({
      kind: "stream-interrupted",
      retryable: true,
    });
    expect(() => {
      provider.assertDone();
    }).toThrow(ScriptViolation);
  });
});

describe("ulid", () => {
  it("encodes time and randomness", () => {
    const id = ulid(1_700_000_000_000);
    expect(id).toMatch(ULID_PATTERN);
    expect(ulidTime(id)).toBe(1_700_000_000_000);
    expect(ulid(1) < ulid(2)).toBe(true);
    expect(ulid()).not.toBe(ulid());
  });
});
