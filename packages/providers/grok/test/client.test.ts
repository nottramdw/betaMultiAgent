import { afterEach, describe, expect, it, vi } from "vitest";
import { createGrokProvider } from "../src/index.js";
import { baseRequest, collect, created, fakeFetch, messageItem, sseResponse, terminal, wireResponse } from "./helpers.js";

function okStream(): Response {
  return sseResponse([created(), terminal("response.completed", wireResponse({ output: [messageItem("ok")] }))]);
}

describe("grok client construction", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("prefers the explicit key and default base url over the environment", async () => {
    vi.stubEnv("XAI_API_KEY", "ambient-key");
    const { fetch, calls } = fakeFetch(okStream);
    const provider = createGrokProvider({ apiKey: "explicit-key", fetch, maxRetries: 0 });
    await collect(provider.stream(baseRequest(), new AbortController().signal));
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer explicit-key");
    expect(calls[0]?.url).toBe("https://api.x.ai/v1/responses");
  });

  it("honours an explicit base url", async () => {
    const { fetch, calls } = fakeFetch(okStream);
    const provider = createGrokProvider({ apiKey: "explicit-key", baseURL: "https://gateway.example/v1", fetch, maxRetries: 0 });
    await collect(provider.stream(baseRequest(), new AbortController().signal));
    expect(calls[0]?.url).toBe("https://gateway.example/v1/responses");
  });

  it("never writes the key to the console when sdk debugging is enabled", async () => {
    vi.stubEnv("XAI_DEBUG", "1");
    const sinks = (["log", "debug", "info", "warn", "error"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const { fetch } = fakeFetch(okStream);
    const provider = createGrokProvider({ apiKey: "explicit-key", fetch, maxRetries: 0 });
    await collect(provider.stream(baseRequest(), new AbortController().signal));
    for (const sink of sinks) {
      for (const args of sink.mock.calls) {
        expect(JSON.stringify(args)).not.toContain("explicit-key");
      }
    }
  });

  it("requires an api key", () => {
    expect(() => createGrokProvider({ apiKey: "" })).toThrow(TypeError);
  });

  it("exposes the provider id", () => {
    expect(createGrokProvider({ apiKey: "explicit-key" }).id).toBe("grok");
  });
});
