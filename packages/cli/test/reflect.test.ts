import { ScriptedProvider } from "@betamultiagent/core/testing";
import { describe, expect, it } from "vitest";
import type { AuditRecord } from "../src/audit/audit-ledger.js";
import { EXIT_FAILED, EXIT_OK } from "../src/cli-error.js";
import { PROPOSE_IMPROVEMENTS, REFLECT_SYSTEM, buildDigest } from "../src/reflect/reflection.js";
import { makeSandbox, registerCleanup, runBma, type Sandbox } from "./cli-harness.js";

registerCleanup();

const USAGE = { turns: 3, promptTokens: 10, inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5, reasoningTokens: 0, costUsd: 0.25, costSource: "estimated" as const };

function record(runId: string, ts: string, body: Record<string, unknown>): AuditRecord {
  return { v: 1, ts, runId, ...body } as AuditRecord;
}

const REFLECTION = {
  summary: "Verification failed twice because the test command was missing.",
  memory: [{ text: "Verify with corepack pnpm test.", evidence: "Runs R1 and R2 failed verification." }],
  skills: [{ skill: "executor", change: "Run the verification command before submitting.", evidence: "R1" }],
};

function reviewer(input: unknown = REFLECTION): ScriptedProvider {
  return new ScriptedProvider(
    [{ respond: { parts: [{ type: "tool-call", id: "reflect-1", name: PROPOSE_IMPROVEMENTS, input }], usage: { costUsd: 0.01, costSource: "estimated" } } }],
    { id: "claude" },
  );
}

async function seedRun(sandbox: Sandbox): Promise<void> {
  const provider = new ScriptedProvider([{ respond: { text: "done" } }], { id: "claude" });
  expect((await runBma(sandbox, ["run", "fix the flaky build"], { providers: { claude: provider } })).code).toBe(EXIT_OK);
}

describe("reflection digest", () => {
  it("summarises recent runs, denials, problem tasks and existing memory", () => {
    const since = new Date("2026-11-20T00:00:00.000Z");
    const records = [
      record("OLD", "2026-11-01T00:00:00.000Z", { kind: "run-start", command: "run", roles: {}, budget: {}, taskSha256: "a".repeat(64), taskPrefix: "old work" }),
      record("R1", "2026-11-21T00:00:00.000Z", { kind: "run-start", command: "team", roles: {}, budget: {}, taskSha256: "b".repeat(64), taskPrefix: "add parser", taskId: "T1" }),
      ...[1, 2].map(() =>
        record("R1", "2026-11-21T00:01:00.000Z", { kind: "permission", role: "executor", sessionId: "S", action: "exec", target: ["rm", "-rf", "dist"], allowed: false, source: "hard-deny" }),
      ),
      record("R1", "2026-11-21T00:02:00.000Z", {
        kind: "run-outcome",
        status: "needs-human",
        code: "unverified",
        verification: "failed",
        revisions: 2,
        invalidInputs: 1,
        usage: USAGE,
        usageByRole: {},
        approvedCommands: [],
        unapprovedCommands: [{ argv: ["pnpm", "test"], source: "not-approved" }],
      }),
    ];
    const task = { id: "T1", title: "Add parser", goal: "g", mode: "team" as const, acceptance: [], dependencies: [], status: "needs-human" as const, createdAt: "2026-11-21T00:00:00.000Z", updatedAt: "2026-11-21T00:03:00.000Z", history: [{ ts: "2026-11-21T00:03:00.000Z", status: "needs-human" as const, code: "unverified", message: "verification failed" }] };
    const memory = [{ id: "M1", text: "Use Node 22.", source: { agent: "lead", sessionId: "S" }, proposedAt: "2026-11-01T00:00:00.000Z", status: "approved" as const }];
    const digest = buildDigest({ records, tasks: [task], memory, since });
    expect(digest).toMatchObject({ runs: 1, tasks: 1 });
    expect(digest.text).not.toContain("old work");
    expect(digest.text).toContain("status needs-human (unverified), verification failed, revisions 2");
    expect(digest.text).toContain("denied 2x: executor exec rm -rf dist (hard-deny)");
    expect(digest.text).toContain("unapproved command: pnpm test (not-approved)");
    expect(digest.text).toContain("task T1 needs-human (team): Add parser; last: unverified: verification failed");
    expect(digest.text).toContain("[approved] Use Node 22.");
  });
});

describe("bma reflect", () => {
  it("makes no request when there is nothing to reflect on", async () => {
    const sandbox = makeSandbox();
    const provider = reviewer();
    const result = await runBma(sandbox, ["reflect", "--json"], { providers: { claude: provider } });
    expect(result.code).toBe(EXIT_OK);
    expect(provider.requests).toHaveLength(0);
    expect(result.stdout.jsonLines().at(-1)).toMatchObject({ type: "reflect", runs: 0 });
  });

  it("records memory proposals as pending and only prints skill suggestions", async () => {
    const sandbox = makeSandbox();
    await seedRun(sandbox);
    const provider = reviewer();
    const result = await runBma(sandbox, ["reflect"], { providers: { claude: provider } });
    provider.assertDone();
    expect(result.code).toBe(EXIT_OK);
    const request = provider.requests[0];
    expect(request?.system).toBe(REFLECT_SYSTEM);
    expect(JSON.stringify(request?.history)).toContain("fix the flaky build");
    expect(result.stdout.text).toContain("memory proposals (pending):");
    expect(result.stdout.text).toContain("skill suggestions (not applied):");
    const listed = await runBma(sandbox, ["memory", "list", "--json"]);
    const entries = listed.stdout.jsonLines().at(-1)?.["entries"] as { text: string; status: string; reason: string; source: { agent: string } }[];
    expect(entries).toEqual([expect.objectContaining({ text: "Verify with corepack pnpm test.", status: "pending", reason: "Runs R1 and R2 failed verification.", source: expect.objectContaining({ agent: "reflect" }) as unknown })]);
  });

  it("fails without saving when the answer is invalid", async () => {
    const sandbox = makeSandbox();
    await seedRun(sandbox);
    const result = await runBma(sandbox, ["reflect"], { providers: { claude: reviewer({ summary: "x", memory: [], skills: [], extra: true }) } });
    expect(result.code).toBe(EXIT_FAILED);
    expect(result.stderr.text).toContain("the reflection failed");
    const listed = await runBma(sandbox, ["memory", "list", "--json"]);
    expect(listed.stdout.jsonLines().at(-1)?.["entries"]).toEqual([]);
  });
});
