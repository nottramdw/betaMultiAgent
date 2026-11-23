import { createRedactor } from "@betamultiagent/core";
import { ScriptedProvider, type ScriptStep } from "@betamultiagent/core/testing";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLedger, readAuditLedger, type AuditRecord } from "../src/audit/audit-ledger.js";
import { auditArgv, MAX_ARGV_TOKENS } from "../src/audit/audit-recorder.js";
import { EXIT_OK } from "../src/cli-error.js";
import { projectKey } from "../src/config/paths.js";
import { git, initRepo, makeSandbox, makeTempDir, registerCleanup, runBma, writeTree, type Sandbox } from "./cli-harness.js";

registerCleanup();

const SECRET = "sk-ant-test-0123456789abcdefghij";
const DAY_MS = 24 * 60 * 60 * 1000;

let counter = 0;

function call(name: string, input: unknown): ScriptStep {
  counter += 1;
  return { respond: { parts: [{ type: "tool-call", id: `audit-${String(counter)}`, name, input }], usage: { costUsd: 0.01, costSource: "exact" } } };
}

function auditDirOf(sandbox: Sandbox): string {
  return path.join(sandbox.bmaHome, "state", "projects", projectKey(sandbox.workspace), "audit");
}

async function ledgerRecords(sandbox: Sandbox): Promise<AuditRecord[]> {
  const warnings: string[] = [];
  const records = await readAuditLedger(auditDirOf(sandbox), (message) => warnings.push(message));
  expect(warnings).toEqual([]);
  return records;
}

async function openLedger(dir: string, now: Date, retentionDays = 180, warn: (message: string) => void = () => undefined): Promise<AuditLedger> {
  return AuditLedger.open({ dir, runId: "run-1", redactor: createRedactor(), retentionDays, now: () => now, warn });
}

const START = {
  kind: "run-start",
  command: "run",
  roles: { executor: { model: "claude:claude-sonnet-5-5", effort: "provider-default" } },
  budget: {},
  taskSha256: "0".repeat(64),
  taskPrefix: `use ${SECRET}`,
} as const;

describe("audit ledger", () => {
  it("appends redacted records to monthly files and reads them back in order", async () => {
    const dir = path.join(makeTempDir(), "audit");
    const october = await openLedger(dir, new Date("2026-10-31T23:00:00Z"));
    october.record(START);
    await october.close();
    const november = await openLedger(dir, new Date("2026-11-01T01:00:00Z"));
    november.record({ ...START, taskPrefix: "second" });
    await november.close();
    expect(readdirSync(dir).sort()).toEqual(["2026-10.jsonl", "2026-11.jsonl"]);
    expect(readFileSync(path.join(dir, "2026-10.jsonl"), "utf8")).not.toContain(SECRET);
    if (process.platform !== "win32") {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(path.join(dir, "2026-10.jsonl")).mode & 0o777).toBe(0o600);
    }
    const records = await readAuditLedger(dir, () => undefined);
    expect(records.map((record) => (record.kind === "run-start" ? record.taskPrefix : ""))).toEqual(["use [REDACTED]", "second"]);
  });

  it("skips malformed lines with a warning", async () => {
    const dir = path.join(makeTempDir(), "audit");
    const ledger = await openLedger(dir, new Date("2026-11-23T00:00:00Z"));
    ledger.record(START);
    await ledger.close();
    const file = path.join(dir, "2026-11.jsonl");
    writeFileSync(file, `${readFileSync(file, "utf8")}not json\n{"v":1,"kind":"run-start"}\n`);
    const warnings: string[] = [];
    const records = await readAuditLedger(dir, (message) => warnings.push(message));
    expect(records).toHaveLength(1);
    expect(warnings).toEqual(["2026-11.jsonl:2: skipped unparsable audit record", "2026-11.jsonl:3: skipped invalid audit record"]);
  });

  it("removes month files older than the retention period when opened", async () => {
    const dir = makeTempDir();
    writeTree(dir, { "2026-01.jsonl": "", "2026-04.jsonl": "", "2026-05.jsonl": "", "notes.txt": "" });
    const now = new Date(Date.UTC(2026, 4, 1) + 30 * DAY_MS);
    const ledger = await openLedger(dir, now, 30);
    await ledger.close();
    expect(readdirSync(dir).sort()).toEqual(["2026-05.jsonl", "notes.txt"]);
  });

  it("warns once and keeps going when the ledger cannot be written", async () => {
    const blocker = path.join(makeTempDir(), "audit");
    writeFileSync(blocker, "not a directory");
    const warnings: string[] = [];
    const ledger = await openLedger(blocker, new Date("2026-11-23T00:00:00Z"), 180, (message) => warnings.push(message));
    ledger.record(START);
    ledger.record(START);
    await ledger.close();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^audit ledger disabled for this run:/u);
  });

  it("truncates long argument lists and tokens", () => {
    const argv = Array.from({ length: MAX_ARGV_TOKENS + 3 }, (_, index) => (index === 0 ? "x".repeat(500) : String(index)));
    const audited = auditArgv(argv);
    expect(audited).toHaveLength(MAX_ARGV_TOKENS + 1);
    expect(audited[0]).toHaveLength(121);
    expect(audited.at(-1)).toBe("…(+3)");
  });
});

describe("audit ledger in commands", () => {
  it("records a run with its role, model, permissions and per-role cost", async () => {
    const sandbox = makeSandbox();
    const ledgerFile = path.join(auditDirOf(sandbox), "2026-11.jsonl");
    const provider = new ScriptedProvider(
      [
        call("write_file", { path: ledgerFile, content: "forged\n" }),
        call("run_command", { argv: ["node", "-e", "0", ledgerFile] }),
        call("read_file", { path: "missing.txt", offset: "bad" }),
        { respond: { text: "Done.", usage: { costUsd: 0.02, costSource: "exact" } } },
      ],
      { id: "claude" },
    );
    const result = await runBma(sandbox, ["run", `fix it ${SECRET}`], {
      providers: { claude: provider },
      now: new Date("2026-11-23T08:00:00Z"),
    });
    expect(result.code).toBe(EXIT_OK);
    const records = await ledgerRecords(sandbox);
    expect(records.map((record) => record.kind)).toEqual(["run-start", "permission", "permission", "run-outcome"]);
    const [start, permission, exec, outcome] = records;
    expect(start).toMatchObject({ command: "run", roles: { executor: { model: "claude:claude-sonnet-5-5", effort: "provider-default" } } });
    expect(start?.kind === "run-start" ? start.taskPrefix : "").toBe("fix it [REDACTED]");
    expect(permission).toMatchObject({ role: "executor", action: "write", allowed: false, source: "hard-deny" });
    expect(exec).toMatchObject({ role: "executor", action: "exec", allowed: false, source: "hard-deny" });
    expect(outcome).toMatchObject({ status: "completed", invalidInputs: 1, usageByRole: { executor: { turns: 4, costUsd: 0.05 } } });
    expect(readFileSync(ledgerFile, "utf8")).not.toContain("forged");
  });

  it("records a team run with approval sources and survives session and run cleanup", { timeout: 60_000 }, async () => {
    const sandbox = makeSandbox();
    initRepo(sandbox.workspace, sandbox.env);
    writeTree(sandbox.workspace, {
      "README.md": "demo\n",
      "bma.config.json": JSON.stringify({ permissions: { rules: [{ kind: "write", match: "src/**", decision: "allow" }] } }),
    });
    git(sandbox.workspace, ["add", "--all"], sandbox.env);
    git(sandbox.workspace, ["commit", "-q", "-m", "seed"], sandbox.env);
    expect((await runBma(sandbox, ["trust"], { stdin: "y\n", stdinIsTTY: true, stderrIsTTY: true })).code).toBe(EXIT_OK);
    const verify = ["node", "-e", "require('fs').accessSync('src/hello.txt')"];
    const provider = new ScriptedProvider(
      [
        call("submit_plan", {
          title: "Add hello file",
          summary: "Create src/hello.txt.",
          steps: [{ id: "1", title: "Write the file", detail: "src/hello.txt contains hello." }],
          inScope: ["src/**"],
          outOfScope: [],
          verify: [{ argv: verify }],
          stopConditions: [],
        }),
        call("write_file", { path: "src/hello.txt", content: "hello\n" }),
        call("submit_result", { summary: "Added src/hello.txt." }),
        call("submit_review", { verdict: "approve", findings: [], summary: "Looks right." }),
      ],
      { id: "claude" },
    );
    const result = await runBma(sandbox, ["team", "Add a hello file", "--yes-verify", "--json"], { providers: { claude: provider } });
    expect(result.code).toBe(EXIT_OK);
    const runId = (result.stdout.jsonLines().at(-1)?.["outcome"] as { runId: string }).runId;
    const records = await ledgerRecords(sandbox);
    expect(records.every((record) => record.runId === runId)).toBe(true);
    expect(records.map((record) => record.kind)).toEqual(["run-start", "permission", "run-outcome"]);
    expect(records[0]).toMatchObject({ command: "team", roles: { lead: { model: "claude:claude-opus-5-5" }, executor: { model: "claude:claude-sonnet-5-5" } } });
    expect(records[1]).toMatchObject({ role: "executor", action: "write", target: ["src/hello.txt"], allowed: true, source: "rule" });
    const outcome = records[2];
    expect(outcome).toMatchObject({
      status: "approved",
      verification: "passed",
      revisions: 0,
      planCorrections: 0,
      approvedCommands: [{ argv: verify, source: "yes-verify" }],
      unapprovedCommands: [],
      branch: `bma/${runId}`,
    });
    const byRole = outcome?.kind === "run-outcome" ? outcome.usageByRole : {};
    expect(Object.keys(byRole).sort()).toEqual(["executor", "lead", "reviewer"]);
    expect(byRole.executor?.turns).toBe(2);

    expect((await runBma(sandbox, ["sessions", "prune", "--older-than", "0"], { now: new Date(Date.now() + DAY_MS) })).code).toBe(EXIT_OK);
    expect((await runBma(sandbox, ["team", "clean", runId, "--delete-branch", "--yes"])).code).toBe(EXIT_OK);
    expect(existsSync(auditDirOf(sandbox))).toBe(true);
    expect(await ledgerRecords(sandbox)).toHaveLength(3);
  });

  it("marks verify commands as skipped in an untrusted workspace", { timeout: 60_000 }, async () => {
    const sandbox = makeSandbox();
    initRepo(sandbox.workspace, sandbox.env);
    writeTree(sandbox.workspace, { "README.md": "demo\n" });
    git(sandbox.workspace, ["add", "--all"], sandbox.env);
    git(sandbox.workspace, ["commit", "-q", "-m", "seed"], sandbox.env);
    const provider = new ScriptedProvider(
      [
        call("submit_plan", {
          title: "Add notes",
          summary: "Create notes.",
          steps: [{ id: "1", title: "Write", detail: "x" }],
          inScope: ["src/**"],
          outOfScope: [],
          verify: [{ argv: ["node", "--version"] }],
          stopConditions: [],
        }),
        call("submit_result", { summary: "Nothing to do." }),
      ],
      { id: "claude" },
    );
    await runBma(sandbox, ["team", "Add notes"], { providers: { claude: provider } });
    const outcome = (await ledgerRecords(sandbox)).at(-1);
    expect(outcome).toMatchObject({ kind: "run-outcome", approvedCommands: [], unapprovedCommands: [{ argv: ["node", "--version"], source: "untrusted-skip" }] });
  });
});
