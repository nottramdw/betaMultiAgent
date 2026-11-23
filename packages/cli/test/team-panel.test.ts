import type { TeamOutcome } from "@betamultiagent/core";
import { ScriptedProvider, type ScriptStep } from "@betamultiagent/core/testing";
import { describe, expect, it } from "vitest";
import { EXIT_OK, EXIT_STOPPED, EXIT_USAGE } from "../src/cli-error.js";
import type { JudgeRecord } from "../src/judge/model-judge.js";
import { buildPanel, ineligibility, selectCandidate, type PanelCandidate, type PanelResult } from "../src/panel/team-panel.js";
import { git, initRepo, makeSandbox, registerCleanup, runBma, writeTree, type Sandbox } from "./cli-harness.js";
import { hasTool, mentions, RoutedProvider, type Route } from "./routed-provider.js";

registerCleanup();

let counter = 0;

function call(name: string, input: unknown): ScriptStep {
  counter += 1;
  return { respond: { parts: [{ type: "tool-call", id: `call-${String(counter)}`, name, input }] } };
}

function outcome(overrides: { readonly [K in keyof TeamOutcome]?: TeamOutcome[K] | undefined } = {}): TeamOutcome {
  return {
    runId: "run",
    status: "approved",
    verification: "passed",
    verificationRuns: [{ command: { argv: ["node", "-v"] }, ok: true, exitCode: 0, timedOut: false, outputTail: "", durationMs: 1 }],
    unapprovedCommands: [],
    sensitiveChanges: [],
    ignoredPaths: [],
    branch: "bma/run",
    baseCommit: "base",
    commit: "head",
    criteria: [{ id: "AC1", text: "Works", source: "user", status: "PASS", note: "ok" }],
    revisions: 0,
    sessions: [],
    usage: { turns: 3, promptTokens: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costUsd: 1 },
    ...overrides,
  } as TeamOutcome;
}

const passing: JudgeRecord = { model: "claude:claude-haiku-5-5", status: "graded", verdict: "pass", costUsd: 0.01 };

function candidate(index: number, overrides: Partial<PanelCandidate> = {}): PanelCandidate {
  return { index, runId: `r${String(index)}`, status: "approved", verification: "passed", revisions: 0, costUsd: 1, eligible: true, reasons: [], ...overrides };
}

function prepareRepo(sandbox: Sandbox): void {
  initRepo(sandbox.workspace, sandbox.env);
  writeTree(sandbox.workspace, {
    "README.md": "demo\n",
    "bma.config.json": JSON.stringify({ permissions: { rules: [{ kind: "write", match: "src/**", decision: "allow" }] } }),
  });
  git(sandbox.workspace, ["add", "--all"], sandbox.env);
  git(sandbox.workspace, ["commit", "-q", "-m", "seed"], sandbox.env);
}

function candidateRoutes(name: string): Route[] {
  const planTitle = `${name} plan`;
  return [
    {
      name: `${name}-lead`,
      match: (request) => hasTool(request, "submit_plan"),
      script: new ScriptedProvider([
        call("submit_plan", {
          title: planTitle,
          summary: "Create src/greeting.txt.",
          steps: [{ id: "1", title: "Write the file", detail: "src/greeting.txt greets." }],
          inScope: ["src/**"],
          outOfScope: [],
          verify: [{ argv: ["node", "-e", "require('fs').accessSync('src/greeting.txt')"] }],
          stopConditions: [],
          acceptance: [],
        }),
      ]),
    },
    {
      name: `${name}-executor`,
      match: (request) => hasTool(request, "submit_result") && mentions(request, planTitle),
      script: new ScriptedProvider([
        call("write_file", { path: "src/greeting.txt", content: `hello from ${name}\n` }),
        call("submit_result", { summary: "Added src/greeting.txt." }),
      ]),
    },
    {
      name: `${name}-reviewer`,
      match: (request) => hasTool(request, "submit_review") && mentions(request, planTitle),
      script: new ScriptedProvider([
        call("submit_review", { verdict: "approve", criteria: { AC1: { status: "PASS", note: "Read it." } }, findings: [], summary: "Right." }),
      ]),
    },
  ];
}

function judgeRoute(name: string, verdict: "pass" | "fail"): Route {
  return {
    name: `${name}-judge`,
    singleRequest: true,
    match: (request) => hasTool(request, "submit_grade") && mentions(request, `hello from ${name}`),
    script: new ScriptedProvider([
      call("submit_grade", { verdict, criteria: { A1: { status: verdict === "pass" ? "PASS" : "FAIL", note: "From the diff." } }, summary: "Graded." }),
    ]),
  };
}

describe("panel selection", () => {
  it("lists every reason a candidate cannot be selected", () => {
    expect(ineligibility(outcome(), [passing])).toEqual([]);
    expect(
      ineligibility(
        outcome({
          status: "needs-human",
          commit: undefined,
          verification: "skipped",
          criteria: [{ id: "AC1", text: "Works", source: "user", status: "FAIL", note: "no" }],
          sensitiveChanges: ["package.json"],
        }),
        [{ ...passing, verdict: "fail" }, { model: "grok:grok-4.3", status: "error", message: "down", costUsd: 0 }],
      ),
    ).toEqual(["status needs-human", "no commit", "verification skipped", "criteria not PASS: AC1", "sensitive changes", "judge claude:claude-haiku-5-5: fail", "judge grok:grok-4.3: error"]);
    expect(ineligibility(outcome({ verificationRuns: [] }), undefined)).toEqual(["no verification command ran"]);
    expect(
      ineligibility(outcome({ criteria: undefined, acceptance: [{ id: "AC1", text: "Works", source: "user" }] }), undefined),
    ).toEqual(["criteria not assessed"]);
  });

  it("prefers fewer revisions, then lower cost, then order", () => {
    expect(selectCandidate([candidate(1, { revisions: 1 }), candidate(2, { costUsd: 3 }), candidate(3, { costUsd: 2 })])).toBe(3);
    expect(selectCandidate([candidate(1), candidate(2)])).toBe(1);
    expect(selectCandidate([candidate(1, { eligible: false }), candidate(2, { eligible: false })])).toBeUndefined();
  });

  it("totals candidate and judge cost", () => {
    const panel = buildPanel([outcome({ runId: "a" }), outcome({ runId: "b", revisions: 2 })], [[passing], [passing]]);
    expect(panel.selected).toBe(1);
    expect(panel.judgeCostUsd).toBeCloseTo(0.02);
    expect(panel.costUsd).toBeCloseTo(2.02);
  });
});

describe("bma team --candidates", () => {
  it("validates panel options", async () => {
    const sandbox = makeSandbox();
    for (const argv of [
      ["team", "Do it", "--candidates", "1"],
      ["team", "Do it", "--candidates", "5"],
      ["team", "Do it", "--judge", "claude"],
      ["team", "Do it", "--candidates", "2", "--judge", "claude", "--judge", "claude:claude-opus-5-5"],
    ]) {
      expect((await runBma(sandbox, argv)).code, argv.join(" ")).toBe(EXIT_USAGE);
    }
  });

  it("runs candidates in parallel and selects only one that every judge passes", { timeout: 90_000 }, async () => {
    const sandbox = makeSandbox();
    prepareRepo(sandbox);
    expect((await runBma(sandbox, ["trust"], { stdin: "y\n", stdinIsTTY: true, stderrIsTTY: true })).code).toBe(EXIT_OK);
    const provider = new RoutedProvider(
      "claude",
      [...candidateRoutes("alpha"), ...candidateRoutes("beta"), judgeRoute("alpha", "pass"), judgeRoute("beta", "fail")],
      { overlap: ["alpha-lead", "beta-lead"] },
    );
    const result = await runBma(
      sandbox,
      ["team", "Add a greeting file", "--accept", "src/greeting.txt greets", "--candidates", "2", "--judge", "claude:claude-haiku-5-5", "--yes-verify", "--json"],
      { providers: { claude: provider } },
    );
    expect(result.stderr.text).toBe("");
    expect(result.code).toBe(EXIT_OK);
    provider.assertDone();
    const lines = result.stdout.jsonLines();
    expect(lines.filter((line) => line["type"] === "team-outcome")).toHaveLength(2);
    expect(lines.at(-1)?.["type"]).toBe("team-panel");
    const panel = lines.at(-1)?.["panel"] as PanelResult;
    const chosen = panel.candidates.find((entry) => entry.index === panel.selected);
    const other = panel.candidates.find((entry) => entry.index !== panel.selected);
    expect(chosen?.judges?.[0]).toMatchObject({ status: "graded", verdict: "pass" });
    expect(other).toMatchObject({ status: "approved", eligible: false, reasons: ["judge claude:claude-haiku-5-5: fail"] });
    expect(chosen?.branch).not.toBe(other?.branch);
    expect(git(sandbox.workspace, ["show", `${chosen?.branch ?? ""}:src/greeting.txt`], sandbox.env).trim()).toBe("hello from alpha");
    expect(git(sandbox.workspace, ["status", "--porcelain"], sandbox.env)).toBe("");
  });

  it("selects nothing when verification is skipped", { timeout: 90_000 }, async () => {
    const sandbox = makeSandbox();
    prepareRepo(sandbox);
    expect((await runBma(sandbox, ["trust"], { stdin: "y\n", stdinIsTTY: true, stderrIsTTY: true })).code).toBe(EXIT_OK);
    const provider = new RoutedProvider("claude", [...candidateRoutes("alpha"), ...candidateRoutes("beta")]);
    const result = await runBma(sandbox, ["team", "Add a greeting file", "--accept", "src/greeting.txt greets", "--candidates", "2"], {
      providers: { claude: provider },
    });
    expect(result.code).toBe(EXIT_STOPPED);
    provider.assertDone();
    expect(result.stderr.text).toContain("without --yes-verify");
    expect(result.stdout.text).toContain("panel of 2 candidates:");
    expect(result.stdout.text).toContain("not selectable: verification skipped");
    expect(result.stdout.text).toContain("no candidate passed every check");
  });
});
