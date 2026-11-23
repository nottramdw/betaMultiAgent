import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createRedactor,
  defineTool,
  InMemoryEventSink,
  runTeam,
  type AgentRole,
  type CommandPolicy,
  type Environment,
  type ExecResult,
  type PermissionVerdict,
  type ProviderRequest,
  type RepoOps,
  type RunTeamOptions,
  type TeamPlan,
  type TeamRoles,
  type ToolDefinition,
} from "../../src/index.js";
import { ScriptedProvider, type ScriptStep } from "../../src/testing/index.js";
import { allowAll, call, MODEL } from "../agent/agent-fixtures.js";

const MAIN_ROOT = path.resolve("/repo");
const WORKTREE_ROOT = path.resolve("/worktrees/run-1");
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

interface RepoState {
  dirty: string[];
  changed: Set<string>;
  ignoredPrefixes: string[];
  ignoredListing: string[];
  integrityOk: boolean;
  worktreeIntegrityOk: boolean;
  diffText: string;
  diffTruncated: boolean;
  commits: string[];
  worktrees: string[];
}

function repoState(): RepoState {
  return {
    dirty: [],
    changed: new Set(),
    ignoredPrefixes: ["dist/"],
    ignoredListing: [],
    integrityOk: true,
    worktreeIntegrityOk: true,
    diffText: "diff --git a/src/a.ts b/src/a.ts\n+export const a = 1;\n",
    diffTruncated: false,
    commits: [],
    worktrees: [],
  };
}

function fakeRepo(state: RepoState, worktree: boolean): RepoOps {
  const unused = (): Promise<never> => Promise.reject(new Error("not used in tests"));
  return {
    preflight: () =>
      Promise.resolve({ root: MAIN_ROOT, gitDir: `${MAIN_ROOT}/.git`, commonDir: `${MAIN_ROOT}/.git`, baseCommit: BASE, configFingerprint: "f" }),
    addWorktree: (runId) => {
      state.worktrees.push(runId);
      return Promise.resolve({ path: WORKTREE_ROOT, branch: `bma/${runId}` });
    },
    removeWorktree: unused,
    deleteBranch: unused,
    stageAll: () => Promise.resolve(),
    commit: (message) => {
      state.commits.push(message);
      return Promise.resolve({ committed: true, commit: HEAD });
    },
    changedPaths: () => Promise.resolve(worktree ? [...state.changed].sort() : [...state.dirty]),
    listIgnored: () => Promise.resolve([...state.ignoredListing]),
    diff: () => Promise.resolve({ text: state.diffText, truncated: state.diffTruncated }),
    diffStat: () => Promise.resolve([{ path: "src/a.ts", added: 1, removed: 0 }]),
    isIgnored: (paths) => Promise.resolve(paths.filter((item) => state.ignoredPrefixes.some((prefix) => item.startsWith(prefix)))),
    checkIntegrity: () => {
      const ok = worktree ? state.worktreeIntegrityOk && state.integrityOk : state.integrityOk;
      return Promise.resolve({ ok, problems: ok ? [] : ["git config changed during the run"] });
    },
  };
}

interface ExecLog {
  readonly calls: { root: string; argv: readonly string[] }[];
  readonly results: Partial<ExecResult>[];
}

function fakeEnvironment(root: string, exec: ExecLog): Environment {
  return {
    id: `env-${root}`,
    kind: root === MAIN_ROOT ? "local" : "git-worktree",
    root,
    caseSensitive: true,
    resolvePath: (target) => {
      const resolved = path.resolve(root, target);
      return Promise.resolve({ requested: resolved, real: resolved });
    },
    exec: (argv) => {
      exec.calls.push({ root, argv });
      const next = exec.results.shift() ?? {};
      return Promise.resolve({
        exitCode: 0,
        signal: null,
        stdout: "ok",
        stderr: "",
        timedOut: false,
        truncated: false,
        durationMs: 1,
        ...next,
      });
    },
  };
}

function writeTool(state: RepoState): ToolDefinition {
  return defineTool({
    name: "write_file",
    description: "Write or remove a file.",
    input: z.object({ path: z.string(), remove: z.boolean().optional() }),
    capabilities: { readOnly: false },
    permission: (input) => ({ kind: "write", paths: [input.path] }),
    execute: (input) => {
      if (input.remove === true) {
        state.changed.delete(input.path);
      } else {
        const prefix = state.ignoredPrefixes.find((item) => input.path.startsWith(item));
        if (prefix === undefined) {
          state.changed.add(input.path);
        } else if (!state.ignoredListing.includes(prefix)) {
          state.ignoredListing.push(prefix);
        }
      }
      return Promise.resolve({ output: input.path, promptText: "written", isError: false });
    },
  });
}

const readTool = defineTool({
  name: "read_file",
  description: "Read a file.",
  input: z.object({ path: z.string() }),
  capabilities: { readOnly: true },
  permission: (input) => ({ kind: "read", paths: [input.path] }),
  execute: () => Promise.resolve({ output: "", promptText: "contents", isError: false }),
});

function verdict(decision: PermissionVerdict["decision"]): PermissionVerdict {
  return { decision, source: "rule", reason: `${decision} by test policy`, sensitive: false };
}

function policy(decide: (argv: readonly string[]) => PermissionVerdict["decision"] = () => "allow"): CommandPolicy {
  return {
    evaluate: (request) => Promise.resolve(verdict(request.kind === "exec" ? decide(request.argv) : "allow")),
  };
}

const ROLES: TeamRoles = {
  lead: { model: { provider: "scripted", id: MODEL.id } },
  researcher: { model: { provider: "scripted", id: MODEL.id } },
  executor: { model: { provider: "scripted", id: MODEL.id } },
  reviewer: { model: { provider: "scripted", id: MODEL.id } },
};

function plan(overrides: Partial<TeamPlan> = {}): TeamPlan {
  return {
    title: "Add constant a",
    summary: "Export a constant from src/a.ts.",
    steps: [{ id: "1", title: "Write src/a.ts", detail: "Export a = 1." }],
    inScope: ["src/**"],
    outOfScope: ["src/generated/**"],
    verify: [{ argv: ["node", "--test"] }],
    stopConditions: ["The file already exists."],
    ...overrides,
  };
}

let callCounter = 0;

function tool(name: string, input: unknown, expect?: (request: ProviderRequest) => void): ScriptStep {
  callCounter += 1;
  const step: ScriptStep = { respond: { parts: [call(`call-${String(callCounter)}`, name, input)] } };
  return expect === undefined ? step : { ...step, expect };
}

const submitPlan = (value: TeamPlan = plan(), expect?: (request: ProviderRequest) => void): ScriptStep =>
  tool("submit_plan", value, expect);
const write = (target: string, remove = false): ScriptStep => tool("write_file", remove ? { path: target, remove } : { path: target });
const submitResult = (summary = "Done.", expect?: (request: ProviderRequest) => void): ScriptStep =>
  tool("submit_result", { summary }, expect);
const submitReview = (verdictValue: "approve" | "revise" | "block", expect?: (request: ProviderRequest) => void): ScriptStep =>
  tool(
    "submit_review",
    {
      verdict: verdictValue,
      findings: verdictValue === "approve" ? [] : [{ severity: "major", path: "src/a.ts", line: 1, message: "Use a named export." }],
      summary: `Verdict ${verdictValue}.`,
    },
    expect,
  );

function lastUserText(request: ProviderRequest): string {
  const last = request.history.at(-1);
  if (last?.role !== "user") {
    return "";
  }
  return last.parts.map((part) => (part.type === "text" ? part.text : part.content)).join("\n");
}

interface Harness {
  readonly state: RepoState;
  readonly exec: ExecLog;
  readonly provider: ScriptedProvider;
  readonly events: InMemoryEventSink;
  readonly options: RunTeamOptions;
  readonly roles: AgentRole[];
}

function harness(steps: readonly ScriptStep[], overrides: Partial<RunTeamOptions> = {}): Harness {
  const state = repoState();
  const exec: ExecLog = { calls: [], results: [] };
  const provider = new ScriptedProvider(steps);
  const now = (): Date => new Date("2026-11-20T00:00:00.000Z");
  const events = new InMemoryEventSink(now);
  const roles: AgentRole[] = [];
  const options: RunTeamOptions = {
    runId: "run-1",
    root: MAIN_ROOT,
    trusted: true,
    roles: ROLES,
    repo: fakeRepo(state, false),
    openRepo: () => fakeRepo(state, true),
    environments: { create: (root) => Promise.resolve(fakeEnvironment(root, exec)) },
    resolveModel: () => ({ provider, model: MODEL }),
    toolsFor: (role) => {
      roles.push(role);
      return [readTool, writeTool(state)];
    },
    permissionsFor: () => allowAll,
    commandPolicy: policy(),
    events,
    redactor: createRedactor(),
    platform: "linux",
    now,
    ...overrides,
  };
  return { state, exec, provider, events, options, roles };
}

function phases(events: InMemoryEventSink): string[] {
  return events.records.flatMap((record) => (record.type === "team-phase" ? [record.phase] : []));
}

describe("runTeam", () => {
  it("plans, executes, verifies, reviews and commits in one round", async () => {
    const h = harness([
      submitPlan(plan(), (request) => {
        expect(request.tools.map((item) => item.name).sort()).toEqual(["delegate", "read_file", "submit_plan"]);
      }),
      write("src/a.ts"),
      submitResult(),
      submitReview("approve", (request) => {
        expect(request.tools.map((item) => item.name).sort()).toEqual(["read_file", "submit_review"]);
        expect(lastUserText(request)).toContain("+export const a = 1;");
        expect(lastUserText(request)).toContain("Status: passed");
      }),
    ]);
    const outcome = await runTeam("Add a constant.", h.options);
    h.provider.assertDone();
    expect(outcome).toMatchObject({
      runId: "run-1",
      status: "approved",
      verification: "passed",
      branch: "bma/run-1",
      worktreePath: WORKTREE_ROOT,
      baseCommit: BASE,
      commit: HEAD,
      revisions: 0,
    });
    expect(h.state.commits).toEqual(["bma: Add constant a"]);
    expect(h.exec.calls).toEqual([{ root: WORKTREE_ROOT, argv: ["node", "--test"] }]);
    expect(outcome.sessions.map((session) => session.role)).toEqual(["lead", "executor", "reviewer"]);
    expect(phases(h.events)).toEqual(["preflight", "plan", "worktree", "execute", "collect", "verify", "review", "review", "commit", "done"]);
  });

  it("returns the reviewer's findings to the same executor session and approves after revision", async () => {
    const h = harness([
      submitPlan(),
      write("src/a.ts"),
      submitResult(),
      submitReview("revise"),
      submitResult("Fixed.", (request) => {
        const last = request.history.at(-1);
        expect(last?.role).toBe("user");
        expect(last?.role === "user" ? last.parts[0]?.type : undefined).toBe("tool-result");
        expect(lastUserText(request)).toContain("[major] src/a.ts:1 Use a named export.");
      }),
      submitReview("approve"),
    ]);
    const outcome = await runTeam("Add a constant.", h.options);
    h.provider.assertDone();
    expect(outcome.status).toBe("approved");
    expect(outcome.revisions).toBe(1);
    expect(outcome.sessions.map((session) => session.role)).toEqual(["lead", "executor", "reviewer", "reviewer"]);
  });

  it("sends out-of-scope changes back to the executor", async () => {
    const h = harness([
      submitPlan(),
      write("src/a.ts"),
      write("docs/notes.md"),
      submitResult(),
      tool("write_file", { path: "docs/notes.md", remove: true }, (request) => {
        expect(lastUserText(request)).toContain("- docs/notes.md");
      }),
      submitResult("Reverted."),
      submitReview("approve"),
    ]);
    const outcome = await runTeam("Add a constant.", h.options);
    h.provider.assertDone();
    expect(outcome.status).toBe("approved");
    expect(outcome.revisions).toBe(1);
  });

  it("treats paths matching outOfScope as violations even inside inScope", async () => {
    const h = harness([submitPlan(), write("src/generated/x.ts"), submitResult(), submitResult(), submitResult()]);
    const outcome = await runTeam("Add a constant.", h.options);
    expect(outcome).toMatchObject({ status: "needs-human", code: "revision-limit", revisions: 2 });
  });

  it("sends a failing verification command back with its output tail", async () => {
    const h = harness([
      submitPlan(),
      write("src/a.ts"),
      submitResult(),
      submitResult("Fixed the test.", (request) => {
        expect(lastUserText(request)).toContain('["node","--test"] exited with code 1');
        expect(lastUserText(request)).toContain("assertion failed");
      }),
      submitReview("approve"),
    ]);
    h.exec.results.push({ exitCode: 1, stdout: "", stderr: "assertion failed" });
    const outcome = await runTeam("Add a constant.", h.options);
    h.provider.assertDone();
    expect(outcome).toMatchObject({ status: "approved", verification: "passed", revisions: 1 });
    expect(h.exec.calls).toHaveLength(2);
  });

  it("stops for a human after the revision limit", async () => {
    const h = harness([
      submitPlan(),
      write("src/a.ts"),
      submitResult(),
      submitReview("revise"),
      submitResult(),
      submitReview("revise"),
      submitResult(),
      submitReview("revise"),
    ]);
    const outcome = await runTeam("Add a constant.", h.options);
    h.provider.assertDone();
    expect(outcome).toMatchObject({ status: "needs-human", code: "revision-limit", revisions: 2 });
    expect(outcome.review?.verdict).toBe("revise");
    expect(h.state.commits).toEqual([]);
  });

  it("stops for a human when an agent refuses", async () => {
    const h = harness([{ respond: { text: "I cannot help with that.", stopReason: "refusal" } }]);
    const outcome = await runTeam("Add a constant.", h.options);
    expect(outcome).toMatchObject({ status: "needs-human", code: "refused" });
    expect(h.state.worktrees).toEqual([]);
  });

  it("reports a blocking review without committing", async () => {
    const h = harness([submitPlan(), write("src/a.ts"), submitResult(), submitReview("block")]);
    const outcome = await runTeam("Add a constant.", h.options);
    expect(outcome).toMatchObject({ status: "blocked", code: "review-blocked", message: "Verdict block." });
    expect(h.state.commits).toEqual([]);
  });

  it("stops when the run exceeds its cost budget", async () => {
    const h = harness(
      [{ respond: { parts: [call("plan-1", "submit_plan", plan())], usage: { costUsd: 2, costSource: "exact" } } }],
      { budget: { maxCostUsd: 1 } },
    );
    const outcome = await runTeam("Add a constant.", h.options);
    expect(outcome).toMatchObject({ status: "budget-exceeded", code: "budget-cost" });
    expect(outcome.usage.costUsd).toBe(2);
    expect(h.state.worktrees).toEqual([]);
  });

  it("refuses to start on a dirty working tree", async () => {
    const h = harness([]);
    h.state.dirty.push("README.md");
    const outcome = await runTeam("Add a constant.", h.options);
    expect(outcome).toMatchObject({ status: "failed", code: "dirty-tree" });
    expect(outcome.sessions).toEqual([]);
  });

  it("stops for a human on a sensitive change and skips verification", async () => {
    const h = harness([submitPlan(plan({ inScope: ["**"] })), write("package.json"), submitResult()]);
    const outcome = await runTeam("Add a constant.", h.options);
    h.provider.assertDone();
    expect(outcome).toMatchObject({ status: "needs-human", code: "sensitive-changes", verification: "skipped" });
    expect(outcome.sensitiveChanges).toEqual(["package.json"]);
    expect(h.exec.calls).toEqual([]);
  });

  it("stops for a human when a tool writes to an ignored path", async () => {
    const h = harness([submitPlan(plan({ inScope: ["**"] })), write("dist/bundle.js"), submitResult()]);
    const outcome = await runTeam("Add a constant.", h.options);
    expect(outcome).toMatchObject({ status: "needs-human", code: "sensitive-changes" });
    expect(outcome.sensitiveChanges).toEqual(["dist/bundle.js"]);
    expect(outcome.ignoredPaths).toEqual(["dist/"]);
  });

  it("skips verification in an untrusted workspace", async () => {
    const h = harness([submitPlan(), write("src/a.ts"), submitResult(), submitReview("approve")], { trusted: false });
    const outcome = await runTeam("Add a constant.", h.options);
    expect(outcome).toMatchObject({ status: "approved", verification: "skipped" });
    expect(outcome.unapprovedCommands).toEqual([{ argv: ["node", "--test"] }]);
    expect(h.exec.calls).toEqual([]);
  });

  it("asks the approver for commands the policy does not allow outright", async () => {
    const asked: string[][] = [];
    const h = harness([submitPlan(), write("src/a.ts"), submitResult(), submitReview("approve")], {
      commandPolicy: policy(() => "ask"),
      approveCommands: (commands, purpose) => {
        asked.push([purpose, ...commands.map((command) => command.argv.join(" "))]);
        return Promise.resolve(false);
      },
    });
    const outcome = await runTeam("Add a constant.", h.options);
    expect(asked).toEqual([["verify", "node --test"]]);
    expect(outcome).toMatchObject({ status: "approved", verification: "skipped" });
    expect(h.exec.calls).toEqual([]);
  });

  it("fails on a repository integrity mismatch", async () => {
    const h = harness([submitPlan(), write("src/a.ts"), submitResult()]);
    const original = h.options.openRepo;
    const options: RunTeamOptions = {
      ...h.options,
      openRepo: (root) => {
        const repo = original(root);
        return {
          ...repo,
          stageAll: () => {
            h.state.worktreeIntegrityOk = false;
            return Promise.resolve();
          },
        };
      },
    };
    const outcome = await runTeam("Add a constant.", options);
    expect(outcome).toMatchObject({ status: "failed", code: "repo-integrity" });
    expect(h.state.commits).toEqual([]);
  });

  it("asks the lead to correct an invalid plan", async () => {
    const h = harness(
      [
        submitPlan(plan({ inScope: ["../outside/**"], verify: [{ argv: ["git", "push"] }] })),
        submitPlan(plan(), (request) => {
          expect(lastUserText(request)).toContain(`inScope pattern "../outside/**" must not contain '..'`);
          expect(lastUserText(request)).toContain('verify command ["git","push"] is denied by policy');
        }),
        write("src/a.ts"),
        submitResult(),
        submitReview("approve"),
      ],
      { commandPolicy: policy((argv) => (argv[0] === "git" ? "deny" : "allow")) },
    );
    const outcome = await runTeam("Add a constant.", h.options);
    h.provider.assertDone();
    expect(outcome.status).toBe("approved");
    expect(outcome.planCorrections).toBe(1);
  });

  it("totals usage per role across every session of that role", async () => {
    const researched = (id: string): ScriptStep => ({
      respond: { parts: [call(id, "submit_result", { summary: "Found." })], usage: { costUsd: 0.25, costSource: "exact" } },
    });
    const h = harness([
      {
        respond: {
          parts: [call("delegate-1", "delegate", { tasks: [{ title: "One", prompt: "First?" }, { title: "Two", prompt: "Second?" }] })],
          usage: { costUsd: 1, costSource: "exact" },
        },
      },
      researched("research-1"),
      researched("research-2"),
      submitPlan(plan()),
      write("src/a.ts"),
      submitResult(),
      submitReview("approve"),
    ]);
    const outcome = await runTeam("Add a constant.", h.options);
    h.provider.assertDone();
    expect(outcome.status).toBe("approved");
    expect(outcome.sessions.filter((session) => session.role === "researcher")).toHaveLength(2);
    expect(outcome.usageByRole?.researcher).toMatchObject({ turns: 2, costUsd: 0.5 });
    expect(outcome.usageByRole?.lead).toMatchObject({ turns: 2, costUsd: 1 });
    const roleTurns = Object.values(outcome.usageByRole ?? {}).reduce((sum, totals) => sum + totals.turns, 0);
    expect(roleTurns).toBe(outcome.usage.turns);
  });

  it("fails after repeated invalid plans", async () => {
    const bad = plan({ inScope: ["/etc/**"] });
    const h = harness([submitPlan(bad), submitPlan(bad), submitPlan(bad)]);
    const outcome = await runTeam("Add a constant.", h.options);
    h.provider.assertDone();
    expect(outcome).toMatchObject({ status: "failed", code: "invalid-plan" });
  });

  it("runs delegated research as read-only researcher sessions", async () => {
    const h = harness([
      tool("delegate", { tasks: [{ title: "Find exports", prompt: "Where are constants exported?" }] }),
      submitResult("Constants live in src/.", (request) => {
        expect(request.tools.map((item) => item.name).sort()).toEqual(["read_file", "submit_result"]);
        expect(lastUserText(request)).toContain("# Research task: Find exports");
      }),
      submitPlan(plan(), (request) => {
        expect(lastUserText(request)).toContain("## 1. Find exports (completed)\nConstants live in src/.");
      }),
      write("src/a.ts"),
      submitResult(),
      submitReview("approve"),
    ]);
    const outcome = await runTeam("Add a constant.", h.options);
    h.provider.assertDone();
    expect(outcome.status).toBe("approved");
    expect(outcome.sessions.map((session) => session.role)).toEqual(["lead", "researcher", "executor", "reviewer"]);
  });

  it("sends the diff stat instead of a truncated diff", async () => {
    const h = harness([
      submitPlan(),
      write("src/a.ts"),
      submitResult(),
      submitReview("approve", (request) => {
        expect(lastUserText(request)).toContain("The diff is too large to include.");
        expect(lastUserText(request)).toContain("1\t0\tsrc/a.ts");
      }),
    ]);
    h.state.diffTruncated = true;
    const outcome = await runTeam("Add a constant.", h.options);
    h.provider.assertDone();
    expect(outcome.status).toBe("approved");
  });

  it("stops when the caller aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness([], { signal: controller.signal });
    const outcome = await runTeam("Add a constant.", h.options);
    expect(outcome.status).toBe("aborted");
  });
});
