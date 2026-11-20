import { ModelInfoSchema, ProviderError, selectPriceTier } from "@betamultiagent/core";
import { describe, expect, it } from "vitest";
import { models, parseModelRef } from "../src/index.js";

describe("claude catalog", () => {
  it("lists the four supported models", () => {
    expect(models.map((entry) => entry.id)).toEqual([
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
      "claude-fable-5-2",
    ]);
  });

  it("satisfies the core model schema", () => {
    for (const entry of models) {
      expect(() => ModelInfoSchema.parse(entry)).not.toThrow();
      expect(entry.defaultMaxOutput).toBeLessThanOrEqual(entry.maxOutput);
    }
  });

  it("rejects ids outside the catalog", () => {
    expect(() => parseModelRef({ id: "claude-unknown" })).toThrow(ProviderError);
    try {
      parseModelRef({ id: "claude-unknown" });
    } catch (error) {
      expect(error).toMatchObject({ kind: "invalid-request", retryable: false });
    }
  });

  it("accepts catalog ids with a supported effort", () => {
    expect(parseModelRef({ id: "claude-opus-5-5", effort: "max" }).id).toBe("claude-opus-5-5");
  });

  it("selects haiku price tiers by prompt size", () => {
    const haiku = parseModelRef({ id: "claude-haiku-5-5" });
    const tiers = haiku.pricing ?? [];
    expect(selectPriceTier(tiers, 100_000)?.inputPerMTok).toBe(0.1);
    expect(selectPriceTier(tiers, 100_001)?.inputPerMTok).toBe(0.5);
  });

  it("stamps the pricing date", () => {
    for (const entry of models) {
      expect(entry.pricingAsOf).toBe("2026-11-20");
    }
  });
});
