import { ScriptedProvider, type ScriptStep } from "@betamultiagent/core/testing";
import { describe, expect, it } from "vitest";
import { EXIT_OK, EXIT_USAGE } from "../src/cli-error.js";
import { git, initRepo, makeSandbox, registerCleanup, runBma, writeTree, type Sandbox } from "./cli-harness.js";

registerCleanup();

let counter = 0;

function call(name: string, input: unknown): ScriptStep {
  counter += 1;
  return { respond: { parts: [{ type: "tool-call", id: `call-${String(counter)}`, name, input }] } };
}

function teamScript(criteria: Record<string, unknown> = { AC1: { status: "PASS", note: "Checked." } }): ScriptedProvider {
  return new ScriptedProvider(
    [
      call("submit_plan", {
        title: "Add hello file",
        summary: "Create src/hello.txt.",
        steps: [{ id: "1", title: "Write the file", detail: "src/hello.txt contains hello." }],
        inScope: ["src/**"],
        outOfScope: [],
        verify: [{ argv: ["node", "-e", "require('fs').accessSync('src/hello.txt')"] }],
        stopConditions: [],
        acceptance: ["The change is correct."],
      }),
      call("write_file", { path: "src/hello.txt", content: "hello\n" }),
      call("submit_result", { summary: "Added src/hello.txt." }),
      call("submit_review", { verdict: "approve", criteria, findings: [], summary: "Looks right." }),
    ],
    { id: "claude" },
  );
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

interface OutcomeLine {
  readonly runId: string;
  readonly status: string;
  readonly verification: string;
  readonly branch?: string;
  readonly commit?: string;
  readonly baseCommit?: string;
}

function outcomeOf(lines: Record<string, unknown>[]): OutcomeLine {
  const last = lines.at(-1);
  expect(last?.["type"]).toBe("team-outcome");
  return last?.["outcome"] as OutcomeLine;
}

describe("bma team", () => {
  it("plans, executes, verifies, reviews and commits on a branch, then cleans up", { timeout: 60_000 }, async () => {
    const sandbox = makeSandbox();
    prepareRepo(sandbox);
    const trust = await runBma(sandbox, ["trust"], { stdin: "y\n", stdinIsTTY: true, stderrIsTTY: true });
    expect(trust.code).toBe(EXIT_OK);
    const provider = teamScript();
    const result = await runBma(sandbox, ["team", "Add a hello file", "--yes-verify", "--json"], { providers: { claude: provider } });
    const outcome = outcomeOf(result.stdout.jsonLines());
    expect(result.stderr.text).toBe("");
    expect(outcome).toMatchObject({ status: "approved", verification: "passed", branch: `bma/${outcome.runId}` });
    expect(result.code).toBe(EXIT_OK);
    provider.assertDone();
    expect(provider.requests.map((request) => request.model)).toEqual([
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-sonnet-5-5",
      "claude-opus-5-5",
    ]);
    expect(git(sandbox.workspace, ["show", `${outcome.branch ?? ""}:src/hello.txt`], sandbox.env)).toBe("hello\n");
    expect(git(sandbox.workspace, ["status", "--porcelain"], sandbox.env)).toBe("");

    const headless = await runBma(sandbox, ["team", "clean", outcome.runId], { stdinIsTTY: false });
    expect(headless.code).toBe(EXIT_USAGE);
    const clean = await runBma(sandbox, ["team", "clean", outcome.runId, "--delete-branch", "--yes"]);
    expect(clean.code).toBe(EXIT_OK);
    expect(git(sandbox.workspace, ["branch", "--list", outcome.branch ?? ""], sandbox.env).trim()).toBe("");
    expect(git(sandbox.workspace, ["worktree", "list"], sandbox.env).trim().split("\n")).toHaveLength(1);
  });

  it("skips verification in an untrusted workspace and asks for human review", { timeout: 60_000 }, async () => {
    const sandbox = makeSandbox();
    prepareRepo(sandbox);
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
          acceptance: ["The change is correct."],
        }),
        call("submit_result", { summary: "Nothing to do." }),
      ],
      { id: "claude" },
    );
    const result = await runBma(sandbox, ["team", "Add notes"], { providers: { claude: provider } });
    expect(result.stderr.text).toContain("workspace is not trusted");
    expect(result.stdout.text).toContain("verification (run by the harness): skipped");
    expect(result.stdout.text).toContain('["node","--version"]');
    expect(result.code).not.toBe(EXIT_OK);
  });

  it("passes --accept criteria to the lead and prints the reviewer assessment per criterion", { timeout: 60_000 }, async () => {
    const sandbox = makeSandbox();
    prepareRepo(sandbox);
    expect((await runBma(sandbox, ["trust"], { stdin: "y\n", stdinIsTTY: true, stderrIsTTY: true })).code).toBe(EXIT_OK);
    const provider = teamScript({ AC1: { status: "PASS", note: "Read it." }, AC2: { status: "NOT_RUN", note: "No test covers it." } });
    const result = await runBma(sandbox, ["team", "Add a hello file", "--accept", "src/hello.txt contains hello", "--yes-verify"], {
      providers: { claude: provider },
    });
    provider.assertDone();
    const leadPrompt = JSON.stringify(provider.requests[0]?.history);
    expect(leadPrompt).toContain("Acceptance criteria set by the user");
    expect(leadPrompt).toContain("src/hello.txt contains hello");
    expect(result.stdout.text).toContain("acceptance criteria (reviewer assessment):");
    expect(result.stdout.text).toContain("AC1 PASS [user]: src/hello.txt contains hello");
    expect(result.stdout.text).toContain("AC2 NOT_RUN [lead]: The change is correct.");
    expect(result.stdout.text).toContain("No test covers it.");
    expect(result.code).toBe(EXIT_OK);
  });

  it("rejects an empty --accept criterion", async () => {
    const sandbox = makeSandbox();
    const result = await runBma(sandbox, ["team", "Do it", "--accept", " "], { providers: { claude: teamScript() } });
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr.text).toContain("--accept");
  });

  it("refuses a dirty working tree unless allowed", { timeout: 60_000 }, async () => {
    const sandbox = makeSandbox();
    prepareRepo(sandbox);
    writeTree(sandbox.workspace, { "README.md": "changed\n" });
    const provider = new ScriptedProvider([], { id: "claude" });
    const result = await runBma(sandbox, ["team", "Do it", "--json"], { providers: { claude: provider } });
    const outcome = outcomeOf(result.stdout.jsonLines());
    expect(outcome.status).toBe("failed");
    expect(result.stdout.text).toContain("dirty-tree");
  });

  it("validates arguments before touching the repository", async () => {
    const sandbox = makeSandbox();
    expect((await runBma(sandbox, ["team"], { providers: { claude: teamScript() } })).code).toBe(EXIT_USAGE);
    expect((await runBma(sandbox, ["team", "x", "--max-cost", "-1"], { providers: { claude: teamScript() } })).code).toBe(EXIT_USAGE);
    expect((await runBma(sandbox, ["team", "clean", "not-a-run", "--yes"])).code).toBe(EXIT_USAGE);
  });
});
