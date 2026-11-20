import { checkBudget, estimateCostUsd, selectPriceTier, UsageLedger, type PriceTier, type Usage } from "../../src/index.js";
import { describe, expect, it } from "vitest";

function usage(overrides: Partial<Usage> = {}): Usage {
  return {
    promptTokens: 100,
    inputTokens: 60,
    cacheReadTokens: 30,
    cacheWriteTokens: 10,
    outputTokens: 20,
    costSource: "exact",
    costUsd: 0.01,
    model: "m",
    ...overrides,
  };
}

const tiers: PriceTier[] = [
  { maxPromptTokens: null, inputPerMTok: 2, outputPerMTok: 8, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2.5 },
  { maxPromptTokens: 200_000, inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25 },
];

describe("UsageLedger", () => {
  it("rolls child usage into the parent", () => {
    const parent = new UsageLedger("lead");
    const child = parent.child("executor");
    child.record(usage());
    parent.record(usage());
    expect(child.snapshot()).toMatchObject({ turns: 1, promptTokens: 100 });
    expect(parent.snapshot()).toMatchObject({ turns: 2, promptTokens: 200, outputTokens: 40, costUsd: 0.02 });
  });

  it("marks mixed cost sources as estimated", () => {
    const ledger = new UsageLedger("a");
    ledger.record(usage());
    expect(ledger.snapshot().costSource).toBe("exact");
    ledger.record(usage({ costSource: "estimated" }));
    expect(ledger.snapshot().costSource).toBe("estimated");
  });

  it("treats usage without cost as unknown", () => {
    const ledger = new UsageLedger("a");
    const withoutCost: Usage = { ...usage() };
    delete withoutCost.costUsd;
    ledger.record(withoutCost);
    expect(ledger.snapshot().costSource).toBe("unknown");
  });
});

describe("pricing", () => {
  it("selects the tier by promptTokens", () => {
    expect(selectPriceTier(tiers, 150_000)?.inputPerMTok).toBe(1);
    expect(selectPriceTier(tiers, 200_000)?.inputPerMTok).toBe(1);
    expect(selectPriceTier(tiers, 200_001)?.inputPerMTok).toBe(2);
  });

  it("estimates cost per token class", () => {
    const cost = estimateCostUsd(
      { promptTokens: 1_000_000, inputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1_000_000 },
      tiers,
    );
    expect(cost).toBeCloseTo(10);
    expect(estimateCostUsd(usage(), [])).toBeUndefined();
  });
});

describe("checkBudget", () => {
  const totals = new UsageLedger("a").snapshot();

  it("reports the first exceeded limit", () => {
    expect(checkBudget({ maxTurns: 1 }, { ...totals, turns: 1 }, 0)).toEqual({ ok: false, exceeded: "turns" });
    expect(checkBudget({ maxTurns: 5, maxCostUsd: 1 }, { ...totals, costUsd: 1 }, 0)).toEqual({ ok: false, exceeded: "cost" });
    expect(checkBudget({ maxTurns: 5, maxWallMs: 10 }, totals, 10)).toEqual({ ok: false, exceeded: "wall" });
    expect(checkBudget({ maxTurns: 5 }, totals, 0)).toEqual({ ok: true });
  });
});
