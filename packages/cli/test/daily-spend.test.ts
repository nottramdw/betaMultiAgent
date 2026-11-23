import { ScriptedProvider } from "@betamultiagent/core/testing";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DailySpend, parseLedger, spendDir, type DailySpendOptions } from "../src/budget/daily-spend.js";
import { CliError, EXIT_BUDGET, EXIT_FAILED, EXIT_OK } from "../src/cli-error.js";
import type { LockEnvironment } from "../src/tasks/runner-lock.js";
import { makeSandbox, makeTempDir, registerCleanup, runBma, writeTree, type Sandbox } from "./cli-harness.js";

registerCleanup();

const DAY = new Date("2026-11-23T10:00:00Z");

function lock(overrides: Partial<LockEnvironment> = {}): LockEnvironment {
  return { pid: 4242, hostname: "here", now: () => DAY, isAlive: () => true, ...overrides };
}

function ledger(dir: string, overrides: Partial<DailySpendOptions> = {}): DailySpend {
  return new DailySpend({ dir, limitUsd: 3, now: () => DAY, lock: lock(), warn: () => undefined, ...overrides });
}

function refusal(error: unknown): number | undefined {
  return error instanceof CliError ? error.exitCode : undefined;
}

describe("daily spend ledger", () => {
  it("caps a reservation at the remaining amount and refuses once the cap is reached", async () => {
    const dir = makeTempDir();
    const spend = ledger(dir);
    const first = await spend.reserve(undefined);
    expect(first.amountUsd).toBe(3);
    first.record(1.25);
    await first.release();
    expect(await spend.summary()).toMatchObject({ day: "2026-11-23", spentUsd: 1.25, reservedUsd: 0, remainingUsd: 1.75 });
    const second = await spend.reserve(5);
    expect(second.amountUsd).toBe(1.75);
    second.record(1.75);
    await second.release();
    await expect(spend.reserve(1)).rejects.toSatisfy((error) => refusal(error) === EXIT_BUDGET);
  });

  it("counts open reservations so concurrent runs cannot share the same budget", async () => {
    const spend = ledger(makeTempDir());
    const settled = await Promise.allSettled(Array.from({ length: 5 }, () => spend.reserve(1)));
    expect(settled.filter((entry) => entry.status === "fulfilled")).toHaveLength(3);
    expect(settled.filter((entry) => entry.status === "rejected").map((entry) => refusal(entry.reason))).toEqual([EXIT_BUDGET, EXIT_BUDGET]);
  });

  it("frees reservations of dead processes but keeps their spend", async () => {
    const dir = makeTempDir();
    const crashed = await ledger(dir, { lock: lock({ pid: 1111 }) }).reserve(2);
    crashed.record(0.5);
    await crashed.flush();
    const summary = await ledger(dir, { lock: lock({ isAlive: (pid) => pid !== 1111 }) }).summary();
    expect(summary).toMatchObject({ spentUsd: 0.5, reservedUsd: 0, remainingUsd: 2.5 });
    expect((await ledger(dir).summary()).reservedUsd).toBe(1.5);
  });

  it("starts a new ledger on each UTC day", async () => {
    const dir = makeTempDir();
    await ledger(dir).charge(3);
    expect((await ledger(dir).summary()).remainingUsd).toBe(0);
    expect((await ledger(dir, { now: () => new Date("2026-11-24T00:00:01Z") }).summary()).remainingUsd).toBe(3);
  });

  it("fails closed on an unreadable ledger", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "2026-11-23.jsonl"), "{not json\n");
    await expect(ledger(dir).reserve(1)).rejects.toSatisfy((error) => refusal(error) === EXIT_FAILED);
    expect(() => parseLedger('{"type":"spend","id":"x","costUsd":-1,"at":"t"}\n', "f")).toThrow(/line 1/u);
  });
});

function claudeWithCost(costUsd: number): ScriptedProvider {
  return new ScriptedProvider([{ respond: { text: "Done.", usage: { costUsd, costSource: "estimated" } } }], { id: "claude" });
}

function configure(sandbox: Sandbox, budget: Record<string, number>, project: Record<string, unknown> = {}): void {
  writeTree(sandbox.bmaHome, { "config/config.json": JSON.stringify({ budget }) });
  writeTree(sandbox.workspace, { "bma.config.json": JSON.stringify(project) });
}

function ledgerText(sandbox: Sandbox, now: Date): string {
  return readFileSync(path.join(spendDir(path.join(sandbox.bmaHome, "state")), `${now.toISOString().slice(0, 10)}.jsonl`), "utf8");
}

describe("daily cost cap in commands", () => {
  it("records the spend of a run and refuses the next run once the cap is reached", async () => {
    const sandbox = makeSandbox();
    configure(sandbox, { dailyMaxCostUsd: 0.5 });
    const now = new Date();
    const first = await runBma(sandbox, ["run", "hello"], { providers: { claude: claudeWithCost(0.6) } });
    expect(first.code).toBe(EXIT_OK);
    const entries = parseLedger(ledgerText(sandbox, now), "ledger");
    expect(entries.map((entry) => entry.type)).toEqual(["reserve", "spend", "release"]);
    expect(entries[0]).toMatchObject({ amountUsd: 0.5 });
    const provider = claudeWithCost(0.1);
    const second = await runBma(sandbox, ["run", "again"], { providers: { claude: provider } });
    expect(second.code).toBe(EXIT_BUDGET);
    expect(second.stderr.text).toContain("daily cost cap of $0.5000");
    expect(provider.requests).toHaveLength(0);
  });

  it("leaves a task open when the daily cap refuses it", async () => {
    const sandbox = makeSandbox();
    configure(sandbox, { dailyMaxCostUsd: 1 });
    await ledger(spendDir(path.join(sandbox.bmaHome, "state")), { now: () => new Date(), limitUsd: 1 }).charge(1);
    expect((await runBma(sandbox, ["task", "add", "Summarize the repo", "--ask"])).code).toBe(EXIT_OK);
    const run = await runBma(sandbox, ["task", "run"], { providers: { claude: claudeWithCost(0) } });
    expect(run.code).toBe(EXIT_BUDGET);
    const [listed] = (await runBma(sandbox, ["task", "list", "--json"])).stdout.jsonLines()[0]?.["tasks"] as { id: string; status: string }[];
    expect(listed?.status).toBe("open");
    const shown = (await runBma(sandbox, ["task", "show", listed?.id ?? "", "--json"])).stdout.text;
    expect(shown).toContain('"code":"budget"');
  });

  it("ignores a daily cap from the project configuration", async () => {
    const sandbox = makeSandbox();
    configure(sandbox, {}, { budget: { dailyMaxCostUsd: 0.01 } });
    const result = await runBma(sandbox, ["run", "hello"], { providers: { claude: claudeWithCost(0) } });
    expect(result.code).toBe(EXIT_OK);
    expect(result.stderr.text).toContain("budget.dailyMaxCostUsd is only read from the user configuration");
  });
});
