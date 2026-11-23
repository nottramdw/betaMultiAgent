import { ScriptedProvider } from "@betamultiagent/core/testing";
import { describe, expect, it } from "vitest";
import { EXIT_OK, EXIT_USAGE } from "../src/cli-error.js";
import { PROPOSE_TASKS, SplitProposalSchema } from "../src/tasks/task-split.js";
import { dependenciesDone } from "../src/tasks/task-store.js";
import { makeSandbox, registerCleanup, runBma, type Sandbox } from "./cli-harness.js";

registerCleanup();

interface TaskLine {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly mode: string;
  readonly parent?: string;
  readonly dependencies: readonly string[];
  readonly acceptance: readonly string[];
}

const TTY = { stdinIsTTY: true, stderrIsTTY: true } as const;

const PROPOSAL = {
  tasks: [
    { title: "Add the parser", goal: "Add a parser for the config file.", acceptance: ["The parser reads every key"], after: [] },
    { title: "Wire the parser", goal: "Call the parser at startup.", acceptance: ["Startup fails on a bad config"], after: [1] },
  ],
};

function lead(input: unknown = PROPOSAL): ScriptedProvider {
  return new ScriptedProvider(
    [{ respond: { parts: [{ type: "tool-call", id: "split-1", name: PROPOSE_TASKS, input }], usage: { costUsd: 0.02, costSource: "estimated" } } }],
    { id: "claude" },
  );
}

async function add(sandbox: Sandbox, args: readonly string[]): Promise<string> {
  const result = await runBma(sandbox, ["task", "add", ...args, "--json"]);
  expect(result.code).toBe(EXIT_OK);
  return ((result.stdout.jsonLines().at(-1)?.["task"]) as TaskLine).id;
}

async function list(sandbox: Sandbox): Promise<TaskLine[]> {
  return (await runBma(sandbox, ["task", "list", "--json"])).stdout.jsonLines().at(-1)?.["tasks"] as TaskLine[];
}

describe("split proposal schema", () => {
  it("only lets a task wait for earlier tasks", () => {
    const bad = { tasks: [{ ...PROPOSAL.tasks[0], after: [2] }, PROPOSAL.tasks[1]] };
    expect(SplitProposalSchema.safeParse(bad).success).toBe(false);
    expect(SplitProposalSchema.safeParse({ tasks: [PROPOSAL.tasks[0]] }).success).toBe(false);
    expect(SplitProposalSchema.safeParse(PROPOSAL).success).toBe(true);
  });
});

describe("bma task split", () => {
  it("saves the approved proposal as child tasks and marks the parent as split", async () => {
    const sandbox = makeSandbox();
    const before = await add(sandbox, ["Write the design note", "--ask"]);
    const parent = await add(sandbox, ["Support a config file", "--after", before, "--accept", "Bad configs are rejected"]);
    const later = await add(sandbox, ["Document the config file", "--after", parent]);
    const provider = lead();
    const result = await runBma(sandbox, ["task", "split", parent, "--json"], { ...TTY, stdin: "y\n", providers: { claude: provider } });
    provider.assertDone();
    expect(result.code).toBe(EXIT_OK);
    expect(JSON.stringify(provider.requests[0]?.history)).toContain("Bad configs are rejected");
    expect(result.stderr.text).toContain("1. Add the parser");
    expect(result.stderr.text).toContain("2. Wire the parser (after 1)");
    const record = result.stdout.jsonLines().at(-1);
    expect(record).toMatchObject({ type: "task-split", parent });
    const tasks = await list(sandbox);
    const children = tasks.filter((task) => task.parent === parent);
    expect(children.map((task) => task.title)).toEqual(["Add the parser", "Wire the parser"]);
    const [first, second] = children;
    expect(first?.dependencies).toEqual([before]);
    expect(second?.dependencies).toEqual([before, first?.id]);
    expect(second?.acceptance).toEqual(["Startup fails on a bad config"]);
    expect(tasks.find((task) => task.id === parent)?.status).toBe("split");
    const waiting = await runBma(sandbox, ["task", "run", later]);
    expect(waiting.code).toBe(EXIT_USAGE);
    expect(waiting.stderr.text).toContain(`waits for ${parent}`);
  });

  it("saves nothing when the proposal is declined or no terminal is attached", async () => {
    const sandbox = makeSandbox();
    const parent = await add(sandbox, ["Support a config file"]);
    const declined = await runBma(sandbox, ["task", "split", parent], { ...TTY, stdin: "n\n", providers: { claude: lead() } });
    expect(declined.code).toBe(EXIT_OK);
    expect(declined.stderr.text).toContain("nothing was saved");
    const provider = lead();
    const headless = await runBma(sandbox, ["task", "split", parent], { providers: { claude: provider } });
    expect(headless.code).toBe(EXIT_USAGE);
    expect(provider.requests).toHaveLength(0);
    expect((await list(sandbox)).map((task) => task.status)).toEqual(["open"]);
  });

  it("treats a split task as done once every remaining child is done", () => {
    const base = { title: "t", goal: "g", mode: "team" as const, acceptance: [], createdAt: "2026-11-23T00:00:00.000Z", updatedAt: "2026-11-23T00:00:00.000Z", history: [] };
    const tasks = [
      { ...base, id: "P", dependencies: [], status: "split" as const },
      { ...base, id: "C1", dependencies: [], parent: "P", status: "done" as const },
      { ...base, id: "C2", dependencies: [], parent: "P", status: "open" as const },
      { ...base, id: "D", dependencies: ["P"], status: "open" as const },
    ];
    const dependent = tasks[3];
    expect(dependent === undefined ? undefined : dependenciesDone(dependent, tasks)).toBe(false);
    const cancelled = tasks.map((task) => (task.id === "C2" ? { ...task, status: "cancelled" as const } : task));
    expect(dependent === undefined ? undefined : dependenciesDone(dependent, cancelled)).toBe(true);
  });
});
