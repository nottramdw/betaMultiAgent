import type { CommandPolicy } from "@betamultiagent/core";
import { ScriptedProvider, type ScriptStep } from "@betamultiagent/core/testing";
import { describe, expect, it } from "vitest";
import { EXIT_OK, EXIT_STOPPED, EXIT_USAGE } from "../src/cli-error.js";
import { unattendedCommandPolicy } from "../src/unattended/unattended-policy.js";
import { git, initRepo, makeSandbox, registerCleanup, runBma, writeTree, type Sandbox } from "./cli-harness.js";

registerCleanup();

const VERIFY = ["node", "-e", "require('fs').accessSync('src/hello.txt')"];

let counter = 0;

function call(name: string, input: unknown): ScriptStep {
  counter += 1;
  return { respond: { parts: [{ type: "tool-call", id: `call-${String(counter)}`, name, input }] } };
}

function teamScript(): ScriptedProvider {
  return new ScriptedProvider(
    [
      call("submit_plan", {
        title: "Add hello file",
        summary: "Create src/hello.txt.",
        steps: [{ id: "1", title: "Write the file", detail: "src/hello.txt contains hello." }],
        inScope: ["src/**"],
        outOfScope: [],
        verify: [{ argv: VERIFY }],
        stopConditions: [],
        acceptance: [],
      }),
      call("write_file", { path: "src/hello.txt", content: "hello\n" }),
      call("submit_result", { summary: "Added src/hello.txt." }),
      call("submit_review", { verdict: "approve", criteria: { AC1: { status: "PASS", note: "Read it." } }, findings: [], summary: "Right." }),
    ],
    { id: "claude" },
  );
}

function prepare(sandbox: Sandbox, userRules: readonly unknown[], projectRules: readonly unknown[]): void {
  writeTree(sandbox.bmaHome, { "config/config.json": JSON.stringify({ budget: { dailyMaxCostUsd: 5 }, permissions: { rules: userRules } }) });
  initRepo(sandbox.workspace, sandbox.env);
  writeTree(sandbox.workspace, {
    "README.md": "demo\n",
    "bma.config.json": JSON.stringify({ permissions: { rules: [{ kind: "write", match: "src/**", decision: "allow" }, ...projectRules] } }),
  });
  git(sandbox.workspace, ["add", "--all"], sandbox.env);
  git(sandbox.workspace, ["commit", "-q", "-m", "seed"], sandbox.env);
}

async function runUnattended(sandbox: Sandbox): Promise<{ code: number; status: unknown; verification: unknown }> {
  expect((await runBma(sandbox, ["trust"], { stdin: "y\n", stdinIsTTY: true, stderrIsTTY: true })).code).toBe(EXIT_OK);
  expect((await runBma(sandbox, ["task", "add", "Add a hello file", "--accept", "src/hello.txt contains hello"])).code).toBe(EXIT_OK);
  const provider = teamScript();
  const result = await runBma(sandbox, ["task", "run", "--unattended", "--json"], { providers: { claude: provider }, stdinIsTTY: true, stderrIsTTY: true });
  provider.assertDone();
  const lines = result.stdout.jsonLines();
  const outcome = lines.find((line) => line["type"] === "team-outcome")?.["outcome"] as { verification: string };
  return { code: result.code, status: lines.at(-1)?.["status"], verification: outcome.verification };
}

describe("unattended command policy", () => {
  it("allows only exact user exec allow rules and keeps denials", async () => {
    const inner: CommandPolicy = {
      evaluate: (request) =>
        Promise.resolve(
          request.kind === "exec" && request.argv[0] === "rm"
            ? { decision: "deny", source: "hard-deny", reason: "no", sensitive: false }
            : { decision: "allow", source: "rule", reason: "project", sensitive: false },
        ),
    };
    const policy = unattendedCommandPolicy(
      inner,
      [
        { kind: "exec", match: ["pnpm", "test"], decision: "allow" },
        { kind: "exec", match: ["node", "*"], decision: "allow" },
        { kind: "exec", match: ["rm", "-rf", "x"], decision: "allow" },
      ],
      "linux",
    );
    const decide = async (argv: string[]) => (await policy.evaluate({ kind: "exec", argv, cwd: "/w" })).decision;
    expect(await decide(["pnpm", "test"])).toBe("allow");
    expect(await decide(["pnpm", "test", "--watch"])).toBe("ask");
    expect(await decide(["node", "script.js"])).toBe("ask");
    expect(await decide(["rm", "-rf", "x"])).toBe("deny");
  });
});

describe("bma task run --unattended", () => {
  it("validates its preconditions", async () => {
    const sandbox = makeSandbox();
    const both = await runBma(sandbox, ["task", "run", "--unattended", "--yes-verify"]);
    expect(both.code).toBe(EXIT_USAGE);
    const uncapped = await runBma(sandbox, ["task", "run", "--unattended"]);
    expect(uncapped.code).toBe(EXIT_USAGE);
    expect(uncapped.stderr.text).toContain("budget.dailyMaxCostUsd");
  });

  it("runs verification listed exactly in the user configuration", { timeout: 60_000 }, async () => {
    const sandbox = makeSandbox();
    prepare(sandbox, [{ kind: "exec", match: VERIFY, decision: "allow" }], []);
    expect(await runUnattended(sandbox)).toEqual({ code: EXIT_OK, status: "done", verification: "passed" });
  });

  it("does not run verification allowed only by the project and needs a human", { timeout: 60_000 }, async () => {
    const sandbox = makeSandbox();
    prepare(sandbox, [], [{ kind: "exec", match: VERIFY, decision: "allow" }]);
    expect(await runUnattended(sandbox)).toEqual({ code: EXIT_STOPPED, status: "needs-human", verification: "skipped" });
  });
});
