import { afterEach, describe, expect, it, vi } from "vitest";
import { createClaudeProvider } from "../src/index.js";
import { baseRequest, collect, fakeFetch, frame, messageDelta, messageStart, sseResponse, textBlock } from "./helpers.js";

const STOP = frame({ type: "message_stop" });

function okStream(): Response {
  return sseResponse([
    frame(messageStart()),
    ...textBlock(0, ["ok"]),
    frame(messageDelta({ stopReason: "end_turn" })),
    STOP,
  ]);
}

describe("claude client construction", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("ignores ambient credentials, log level and base url", async () => {
    vi.stubEnv("ANTHROPIC_LOG", "debug");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "ambient-token");
    vi.stubEnv("ANTHROPIC_API_KEY", "ambient-key");
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://ambient.invalid");
    const sinks = (["log", "debug", "info", "warn"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const { fetch, calls } = fakeFetch(okStream);
    const provider = createClaudeProvider({ apiKey: "explicit-key", fetch, maxRetries: 0 });
    await collect(provider.stream(baseRequest(), new AbortController().signal));
    const call = calls[0];
    expect(call?.headers.get("authorization")).toBe("Bearer explicit-key");
    expect(call?.headers.get("x-api-key")).toBeNull();
    expect(call?.url.startsWith("https://api.anthropic.com/")).toBe(true);
    for (const sink of sinks) {
      expect(sink).not.toHaveBeenCalled();
    }
  });

  it("honours an explicit base url", async () => {
    const { fetch, calls } = fakeFetch(okStream);
    const provider = createClaudeProvider({ apiKey: "explicit-key", baseURL: "https://gateway.example", fetch, maxRetries: 0 });
    await collect(provider.stream(baseRequest(), new AbortController().signal));
    expect(calls[0]?.url.startsWith("https://gateway.example/")).toBe(true);
  });

  it("requires an api key", () => {
    expect(() => createClaudeProvider({ apiKey: "" })).toThrow(TypeError);
  });

  it("exposes the provider id", () => {
    expect(createClaudeProvider({ apiKey: "explicit-key" }).id).toBe("claude");
  });
});
