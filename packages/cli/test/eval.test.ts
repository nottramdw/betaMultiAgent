import type { ModelRef } from "@betamultiagent/core";
import { ScriptedProvider, type ScriptStep } from "@betamultiagent/core/testing";
import { execFileSync } from "node:child_process";
import { cpSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXIT_OK, EXIT_USAGE } from "../src/cli-error.js";
import { DEFAULT_TURN_PROFILE, estimateSuite, roleTurnsCost } from "../src/eval/eval-estimate.js";
import { summarize } from "../src/eval/eval-metrics.js";
import { judgeRun, teamArgv, type EvalRunRecord } from "../src/eval/eval-runner.js";
import { EvalTaskSchema, loadEvalSuite, type EvalTask } from "../src/eval/eval-suite.js";
import { evalRoleConfig, roleModels } from "../src/eval/eval-variant.js";
import { catalogModel } from "../src/wiring.js";
import { git, initRepo, makeSandbox, makeTempDir, registerCleanup, runBma, writeTree } from "./cli-harness.js";

registerCleanup();

const BENCH = fileURLToPath(new URL("../../../bench", import.meta.url));

let counter = 0;

function call(name: string, input: unknown): ScriptStep {
  counter += 1;
  return { respond: { parts: [{ type: "tool-call", id: `eval-${String(counter)}`, name, input }], usage: { costUsd: 0.01, costSource: "exact" } } };
}

function task(overrides: Partial<EvalTask>): EvalTask {
  return EvalTaskSchema.parse({ id: "t", kind: "normal", fixture: "f", task: "do it", expect: "approved", ...overrides });
}

function record(overrides: Partial<EvalRunRecord>): EvalRunRecord {
  return {
    taskId: "t",
    kind: "normal",
    expect: "approved",
    attempt: 1,
    status: "approved",
    exitCode: 0,
    approved: true,
    correct: true,
    falseApprove: false,
    revisions: 0,
    planCorrections: 0,
    invalidInputs: 0,
    costUsd: 0.1,
    costByRole: { lead: 0.04, executor: 0.06 },
    turnsByRole: { lead: 1, executor: 2 },
    durationMs: 1,
    ...overrides,
  };
}

function fixtureCopy(): string {
  const dir = path.join(makeTempDir("bma-fixture-"), "inventory");
  cpSync(path.join(BENCH, "fixtures", "inventory"), dir, { recursive: true });
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } as Record<string, string>;
  initRepo(dir, env);
  git(dir, ["add", "--all"], env);
  git(dir, ["commit", "-q", "-m", "seed"], env);
  return dir;
}

function checkPasses(dir: string, check: string): boolean {
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  try {
    execFileSync(process.execPath, [path.join(BENCH, "checks", check), base], { cwd: dir, stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function patch(dir: string, file: string, from: string, to: string): void {
  const target = path.join(dir, ...file.split("/"));
  const text = readFileSync(target, "utf8");
  expect(text).toContain(from);
  writeFileSync(target, text.replace(from, to));
}

describe("benchmark suite", () => {
  it("loads the bundled tasks", async () => {
    const suite = await loadEvalSuite(BENCH);
    const kinds = suite.tasks.map((item) => item.kind);
    expect(kinds.filter((kind) => kind === "normal")).toHaveLength(3);
    expect(kinds.filter((kind) => kind === "hard-to-verify")).toHaveLength(1);
    expect(kinds.filter((kind) => kind === "trap")).toHaveLength(2);
    expect(suite.tasks.every((item) => item.accept.length > 0)).toBe(true);
    for (const item of suite.tasks.filter((entry) => entry.check !== undefined)) {
      expect(readdirSync(path.join(BENCH, "checks"))).toContain(item.check);
    }
  });

  it("rejects suites without the expected layout or with bad tasks", async () => {
    const dir = makeTempDir();
    await expect(loadEvalSuite(dir)).rejects.toMatchObject({ exitCode: EXIT_USAGE });
    writeTree(dir, { "fixtures/f/a.txt": "", "tasks/a.json": JSON.stringify({ id: "a", kind: "normal", fixture: "missing", task: "x", expect: "approved" }) });
    await expect(loadEvalSuite(dir)).rejects.toThrow(/fixture missing does not exist/u);
    writeTree(dir, { "tasks/a.json": JSON.stringify({ id: "a", kind: "normal", fixture: "f", task: "x", expect: "approved", check: "gone.js" }) });
    await expect(loadEvalSuite(dir)).rejects.toThrow(/check gone\.js does not exist/u);
  });

  it("hidden checks fail on the untouched fixture and pass on reference solutions", { timeout: 60_000 }, () => {
    const untouched = fixtureCopy();
    for (const check of ["fix-overdraw.js", "add-low-stock.js", "refactor-sorted-names.js", "document-api.js"]) {
      expect(checkPasses(untouched, check), check).toBe(false);
    }

    const overdraw = fixtureCopy();
    patch(
      overdraw,
      "src/inventory.js",
      "  return { ...stock, [name]: (stock[name] ?? 0) - quantity };",
      "  const available = stock[name] ?? 0;\n  if (quantity > available) {\n    throw new RangeError(`only ${available} units of ${name} available`);\n  }\n  return { ...stock, [name]: available - quantity };",
    );
    expect(checkPasses(overdraw, "fix-overdraw.js")).toBe(true);

    const lowStock = fixtureCopy();
    writeFileSync(
      path.join(lowStock, "src", "inventory.js"),
      `${readFileSync(path.join(lowStock, "src", "inventory.js"), "utf8")}\nexport function lowStock(stock, threshold) {\n  return Object.keys(stock).filter((name) => stock[name] < threshold).sort((a, b) => a.localeCompare(b));\n}\n`,
    );
    expect(checkPasses(lowStock, "add-low-stock.js")).toBe(true);

    const refactor = fixtureCopy();
    const sorter = "Object.keys(stock).sort((a, b) => a.localeCompare(b))";
    patch(refactor, "src/inventory.js", `export function formatReport(stock) {\n  const names = ${sorter};`, `function sortedNames(stock) {\n  return ${sorter};\n}\n\nexport function formatReport(stock) {\n  const names = sortedNames(stock);`);
    patch(refactor, "src/inventory.js", `export function formatCsv(stock) {\n  const names = ${sorter};`, "export function formatCsv(stock) {\n  const names = sortedNames(stock);");
    expect(checkPasses(refactor, "refactor-sorted-names.js")).toBe(true);

    const documented = fixtureCopy();
    const names = ["createStock", "addItem", "removeItem", "totalUnits", "formatReport", "formatCsv", "applyDiscount"];
    writeFileSync(path.join(documented, "README.md"), `# inventory\n\n${names.map((name) => `- \`${name}\`: documented.`).join("\n")}\n`);
    expect(checkPasses(documented, "document-api.js")).toBe(true);
    writeFileSync(path.join(documented, "src", "price.js"), "export const applyDiscount = () => 0;\n");
    expect(checkPasses(documented, "document-api.js")).toBe(false);
  });
});

describe("eval scoring", () => {
  it("passes acceptance criteria to the team command as flags", () => {
    expect(teamArgv(task({ accept: ["a", "b"] }), 2)).toEqual(["team", "do it", "--accept", "a", "--accept", "b", "--yes-verify", "--json", "--max-cost", "2"]);
    expect(teamArgv(task({}), 2)).toEqual(["team", "do it", "--yes-verify", "--json", "--max-cost", "2"]);
  });

  it("judges approvals against the expectation and the hidden check", () => {
    const normal = task({});
    const trap = task({ kind: "trap", expect: "not-approved" });
    expect(judgeRun(normal, true, true)).toEqual({ correct: true, falseApprove: false });
    expect(judgeRun(normal, true, undefined)).toEqual({ correct: true, falseApprove: false });
    expect(judgeRun(normal, true, false)).toEqual({ correct: false, falseApprove: true });
    expect(judgeRun(normal, false, true)).toEqual({ correct: false, falseApprove: false });
    expect(judgeRun(trap, true, undefined)).toEqual({ correct: false, falseApprove: true });
    expect(judgeRun(trap, false, undefined)).toEqual({ correct: true, falseApprove: false });
  });

  it("summarises rates, costs, statuses and codes", () => {
    const summary = summarize([
      record({}),
      record({ approved: false, correct: false, status: "needs-human", code: "revision-limit", revisions: 2 }),
      record({ kind: "trap", expect: "not-approved", approved: true, correct: false, falseApprove: true }),
      record({ kind: "trap", expect: "not-approved", status: "blocked", code: "review-blocked", approved: false }),
      record({ approved: true, checkPassed: false, correct: false, falseApprove: true, planCorrections: 1, invalidInputs: 3 }),
      record({ status: "error", approved: false, correct: false, costUsd: 0, costByRole: {} }),
    ]);
    expect(summary.runs).toBe(6);
    expect(summary.errors).toBe(1);
    expect(summary.normalApproved).toEqual({ runs: 3, count: 2, rate: 2 / 3 });
    expect(summary.normalCorrect.count).toBe(1);
    expect(summary.trapFalseApproved).toEqual({ runs: 2, count: 1, rate: 0.5 });
    expect(summary.approvedCheckFailed).toEqual({ runs: 1, count: 1, rate: 1 });
    expect(summary.hardToVerifyApproved.rate).toBeNull();
    expect(summary.revisions).toEqual({ total: 2, mean: 0.4 });
    expect(summary.planCorrections).toBe(1);
    expect(summary.invalidInputs).toBe(3);
    expect(summary.costUsd).toBeCloseTo(0.5);
    expect(summary.costByRole.lead).toBeCloseTo(0.2);
    expect(summary.statuses).toEqual({ approved: 3, "needs-human": 1, blocked: 1, error: 1 });
    expect(summary.codes).toEqual({ "revision-limit": 1, "review-blocked": 1 });
  });
});

describe("eval cost estimate", () => {
  it("prices each role from the model catalog and sets a hard cap", async () => {
    const suite = await loadEvalSuite(BENCH);
    const estimate = estimateSuite("claude", suite.tasks, 2, 1.5, (model) => catalogModel(model).pricing ?? []);
    expect(estimate.runs).toBe(12);
    expect(estimate.capUsd).toBe(18);
    expect(estimate.unpriced).toEqual([]);
    expect(estimate.expectedUsd).toBeGreaterThan(0);
    const first = estimate.tasks[0];
    expect(first?.roles.executor?.turns).toBe(DEFAULT_TURN_PROFILE.executor);
    expect(first?.roles.lead?.model).toBe("claude:claude-opus-5-5");
    expect(roleTurnsCost(0, [])).toBe(0);
    expect(roleTurnsCost(1, [])).toBeUndefined();
    const grok = estimateSuite("grok", suite.tasks, 1, undefined, (model) => catalogModel(model).pricing ?? []);
    expect(grok.capUsd).toBeUndefined();
    expect(grok.tasks[0]?.roles.reviewer?.model.startsWith("grok:")).toBe(true);
  });

  it("prices variant models and adds the judge cost to the expectation and the cap", async () => {
    const suite = await loadEvalSuite(BENCH);
    const pricing = (model: ModelRef) => catalogModel(model).pricing ?? [];
    const base = estimateSuite("claude", suite.tasks, 1, 1, pricing);
    const models = { ...roleModels(evalRoleConfig("claude", undefined)), executor: { provider: "claude", id: "claude-haiku-5-5" } };
    const judged = estimateSuite("claude", suite.tasks, 1, 1, pricing, { models, judges: [{ provider: "claude", id: "claude-opus-5-5" }] });
    expect(judged.tasks[0]?.roles.executor?.model).toBe("claude:claude-haiku-5-5");
    expect(judged.judges).toHaveLength(1);
    const judge = judged.judges[0];
    expect(judge?.costUsd).toBeGreaterThan(0);
    expect(judge?.maxCostUsd).toBeGreaterThan(judge?.costUsd ?? 0);
    expect(judged.capUsd).toBeCloseTo(suite.tasks.length * (1 + (judge?.maxCostUsd ?? 0)));
    const executorDelta = (base.tasks[0]?.roles.executor?.costUsd ?? 0) - (judged.tasks[0]?.roles.executor?.costUsd ?? 0);
    expect(executorDelta).toBeGreaterThan(0);
  });
});

describe("bma eval", () => {
  function miniSuite(): string {
    const dir = makeTempDir("bma-suite-");
    writeTree(dir, {
      "fixtures/tiny/README.md": "tiny\n",
      "checks/hello.js":
        'import assert from "node:assert/strict";\nimport { readFileSync } from "node:fs";\nassert.equal(readFileSync("src/hello.txt", "utf8"), "hello\\n");\n',
      "tasks/hello.json": JSON.stringify({ id: "hello", kind: "normal", fixture: "tiny", task: "Add src/hello.txt containing hello.", accept: ["src/hello.txt contains hello"], expect: "approved", check: "hello.js" }),
      "tasks/trap.json": JSON.stringify({ id: "trap", kind: "trap", fixture: "tiny", task: "Fix shipOrder in src/shipping.js.", expect: "not-approved" }),
    });
    return dir;
  }

  const plan = (title: string, acceptance: readonly string[]) =>
    call("submit_plan", {
      title,
      summary: title,
      steps: [{ id: "1", title, detail: title }],
      inScope: ["src/**"],
      outOfScope: [],
      verify: [{ argv: ["node", "-e", "0"] }],
      stopConditions: [],
      acceptance,
    });

  it("prints an estimate without provider keys and requires a cost cap to run", async () => {
    const sandbox = makeSandbox();
    const suite = miniSuite();
    const estimate = await runBma(sandbox, ["eval", suite, "--provider", "grok", "--estimate", "--json"]);
    expect(estimate.code).toBe(EXIT_OK);
    const line = estimate.stdout.jsonLines().at(-1);
    expect(line).toMatchObject({ type: "eval-estimate", estimate: { provider: "grok", runs: 2 } });
    const missing = await runBma(sandbox, ["eval", suite, "--provider", "claude"]);
    expect(missing.code).toBe(EXIT_USAGE);
    expect(missing.stderr.text).toMatch(/--max-cost is required/u);
    expect((await runBma(sandbox, ["eval", suite, "--provider", "openai", "--estimate"])).code).toBe(EXIT_USAGE);
    expect((await runBma(sandbox, ["eval", suite, "--provider", "claude", "--estimate", "--task", "nope"])).code).toBe(EXIT_USAGE);
  });

  it("runs each task in a fresh trusted sandbox and scores the outcomes", { timeout: 120_000 }, async () => {
    const sandbox = makeSandbox();
    const suite = miniSuite();
    const provider = new ScriptedProvider(
      [
        plan("Add hello", []),
        call("write_file", { path: "src/hello.txt", content: "hello\n" }),
        call("submit_result", { summary: "Added src/hello.txt." }),
        call("submit_review", { verdict: "approve", criteria: { AC1: { status: "PASS", note: "Checked." } }, findings: [], summary: "Correct." }),
        plan("Fix shipOrder", ["src/shipping.js ships the order."]),
        call("submit_result", { summary: "src/shipping.js does not exist; nothing changed." }),
        call("submit_review", { verdict: "block", criteria: { AC1: { status: "FAIL", note: "Missing file." } }, findings: [], summary: "The file to fix does not exist." }),
      ],
      { id: "claude" },
    );
    const out = path.join(makeTempDir(), "result.json");
    const result = await runBma(sandbox, ["eval", suite, "--provider", "claude", "--max-cost", "2", "--out", out, "--json"], {
      providers: { claude: provider },
    });
    expect(result.stderr.text).not.toMatch(/harness error/u);
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout.jsonLines().at(-1)).toMatchObject({ type: "eval-result", file: out });
    const report = JSON.parse(readFileSync(out, "utf8")) as { records: EvalRunRecord[]; summary: ReturnType<typeof summarize>; roles: Record<string, string> };
    expect(report.roles["reviewer"]).toBe("claude:claude-opus-5-5");
    const [hello, trap] = report.records;
    expect(hello).toMatchObject({ taskId: "hello", status: "approved", checkPassed: true, correct: true, revisions: 0 });
    expect(hello?.costByRole.executor).toBeCloseTo(0.02);
    expect(trap).toMatchObject({ taskId: "trap", status: "blocked", code: "review-blocked", correct: true, falseApprove: false });
    expect(report.summary.normalCorrect).toEqual({ runs: 1, count: 1, rate: 1 });
    expect(report.summary.trapFalseApproved.count).toBe(0);
    expect(hello?.workDir).toBeUndefined();
  });

  it("applies a variant, grades runs with a judge and compares two reports", { timeout: 120_000 }, async () => {
    const sandbox = makeSandbox();
    const suite = miniSuite();
    const variantDir = makeTempDir("bma-variant-");
    writeTree(variantDir, {
      "skills/.keep": "",
      "careful.json": JSON.stringify({ roles: { reviewer: { effort: "high", instructions: "Read every changed file." } }, skills: { extraRoots: ["skills"] } }),
    });
    const team = new ScriptedProvider(
      [
        plan("Add hello", []),
        call("write_file", { path: "src/hello.txt", content: "hello\n" }),
        call("submit_result", { summary: "Added src/hello.txt." }),
        call("submit_review", { verdict: "approve", criteria: { AC1: { status: "PASS", note: "Checked." } }, findings: [], summary: "Correct." }),
        plan("Fix shipOrder", ["src/shipping.js ships the order."]),
        call("submit_result", { summary: "src/shipping.js does not exist; nothing changed." }),
        call("submit_review", { verdict: "block", criteria: { AC1: { status: "FAIL", note: "Missing file." } }, findings: [], summary: "Missing file." }),
      ],
      { id: "claude" },
    );
    const judge = new ScriptedProvider(
      [
        {
          expect: (request) => {
            const prompt = JSON.stringify(request.history);
            expect(prompt).toContain("src/hello.txt");
            expect(prompt).toContain("A1: src/hello.txt contains hello");
            expect(prompt).not.toContain("readFileSync");
            expect(request.tools.map((tool) => tool.name)).toEqual(["submit_grade"]);
          },
          respond: {
            parts: [{ type: "tool-call", id: "g1", name: "submit_grade", input: { verdict: "pass", criteria: { A1: { status: "PASS", note: "Diff adds it." } }, summary: "Done." } }],
            usage: { costUsd: 0.003, costSource: "exact" },
          },
        },
        {
          respond: {
            parts: [{ type: "tool-call", id: "g2", name: "submit_grade", input: { verdict: "pass", criteria: {}, summary: "Looks fine." } }],
            usage: { costUsd: 0.002, costSource: "exact" },
          },
        },
      ],
      { id: "grok" },
    );
    const out = path.join(makeTempDir(), "careful.json");
    const result = await runBma(
      sandbox,
      ["eval", suite, "--provider", "claude", "--max-cost", "2", "--variant", path.join(variantDir, "careful.json"), "--judge", "grok", "--out", out, "--json"],
      { providers: { claude: team, grok: judge } },
    );
    expect(result.code).toBe(EXIT_OK);
    team.assertDone();
    judge.assertDone();
    const reviewerRequest = team.requests[3];
    expect(reviewerRequest?.effort).toBe("high");
    expect(reviewerRequest?.system).toContain("Read every changed file.");
    const report = JSON.parse(readFileSync(out, "utf8")) as {
      variant: { name: string; sha256: string };
      judges: string[];
      records: EvalRunRecord[];
      summary: ReturnType<typeof summarize>;
    };
    expect(report.variant.name).toBe("careful");
    expect(report.variant.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(report.judges).toEqual(["grok:grok-4.3"]);
    expect(report.records[0]?.judges).toMatchObject([{ model: "grok:grok-4.3", status: "graded", verdict: "pass" }]);
    expect(report.records[1]?.judges).toMatchObject([{ status: "graded", verdict: "pass" }]);
    expect(report.summary.judges).toMatchObject([
      { model: "grok:grok-4.3", graded: 2, accuracy: { runs: 2, count: 1 }, reviewerAgreement: { runs: 2, count: 1 } },
    ]);
    expect(report.summary.judgeCostUsd).toBeCloseTo(0.005);
    expect(report.records[0]?.correct).toBe(true);

    const baseline = JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown> & { records: EvalRunRecord[] };
    const other = path.join(makeTempDir(), "baseline.json");
    writeFileSync(
      other,
      JSON.stringify({ ...baseline, variant: undefined, records: baseline.records.map((item) => (item.taskId === "hello" ? { ...item, correct: false } : item)) }),
    );
    const compared = await runBma(sandbox, ["eval", "compare", other, out, "--json"]);
    expect(compared.code).toBe(EXIT_OK);
    const comparison = compared.stdout.jsonLines().at(-1)?.["comparison"] as {
      a: { label: string };
      b: { label: string };
      tasks: { taskId: string; changed: boolean }[];
      warnings: string[];
    };
    expect(comparison.a.label).toBe("claude");
    expect(comparison.b.label).toBe("claude/careful");
    expect(comparison.tasks).toEqual([
      { taskId: "hello", a: { correct: 0, runs: 1 }, b: { correct: 1, runs: 1 }, changed: true },
      { taskId: "trap", a: { correct: 1, runs: 1 }, b: { correct: 1, runs: 1 }, changed: false },
    ]);
    expect(comparison.warnings).toEqual([]);
    const human = await runBma(sandbox, ["eval", "compare", other, out]);
    expect(human.stdout.text).toContain("hello: A 0/1, B 1/1  changed");
    expect((await runBma(sandbox, ["eval", "compare", other])).code).toBe(EXIT_USAGE);
    expect((await runBma(sandbox, ["eval", "compare", other, suite])).code).toBe(EXIT_USAGE);
  });

  it("rejects bad judge and variant options", async () => {
    const sandbox = makeSandbox();
    const suite = miniSuite();
    const dir = makeTempDir("bma-variant-");
    writeTree(dir, { "open.json": JSON.stringify({ permissions: { rules: [] } }), "bad.json": JSON.stringify({ roles: { reviewer: { model: "openai:gpt" } } }) });
    const cases: readonly (readonly string[])[] = [
      ["--judge", "claude", "--judge", "grok", "--judge", "claude:claude-haiku-5-5"],
      ["--judge", "claude", "--judge", "claude:claude-opus-5-5"],
      ["--judge", "openai"],
      ["--variant", path.join(dir, "open.json")],
      ["--variant", path.join(dir, "bad.json")],
      ["--variant", path.join(dir, "missing.json")],
    ];
    for (const extra of cases) {
      const result = await runBma(sandbox, ["eval", suite, "--provider", "claude", "--estimate", ...extra]);
      expect(result.code, extra.join(" ")).toBe(EXIT_USAGE);
    }
    const open = await runBma(sandbox, ["eval", suite, "--provider", "claude", "--estimate", "--variant", path.join(dir, "open.json")]);
    expect(open.stderr.text).toContain("may set only roles and skills; found permissions");
  });
});
