import { ModelInfoSchema, ProviderError, selectPriceTier } from "@betamultiagent/core";
import { describe, expect, it } from "vitest";
import { models, parseModelRef } from "../src/index.js";

describe("grok catalog", () => {
  it("lists the supported models", () => {
    expect(models.map((entry) => entry.id)).toEqual(["grok-4.7", "grok-4.3"]);
  });

  it("satisfies the core model schema", () => {
    for (const entry of models) {
      expect(() => ModelInfoSchema.parse(entry)).not.toThrow();
      expect(entry.defaultMaxOutput).toBeLessThanOrEqual(entry.maxOutput);
    }
  });

  it("rejects ids outside the catalog", () => {
    try {
      parseModelRef({ id: "grok-unknown" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect(error).toMatchObject({ kind: "invalid-request", retryable: false });
    }
  });

  it("accepts a supported effort and rejects an unsupported one", () => {
    expect(parseModelRef({ id: "grok-4.7", effort: "high" }).id).toBe("grok-4.7");
    expect(() => parseModelRef({ id: "grok-4.3", effort: "high" })).toThrow(ProviderError);
  });

  it("switches price tier above the long context threshold", () => {
    const tiers = parseModelRef({ id: "grok-4.7" }).pricing ?? [];
    expect(selectPriceTier(tiers, 199_999)?.inputPerMTok).toBe(2);
    expect(selectPriceTier(tiers, 200_000)?.inputPerMTok).toBe(4);
  });

  it("stamps the pricing date", () => {
    for (const entry of models) {
      expect(entry.pricingAsOf).toBe("2026-11-20");
    }
  });
});
