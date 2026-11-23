import { ScriptedProvider, type ScriptStep } from "@betamultiagent/core/testing";
import { appendFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readAuditLedger } from "../src/audit/audit-ledger.js";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from "../src/cli-error.js";
import { projectKey } from "../src/config/paths.js";
import { git, initRepo, makeSandbox, registerCleanup, runBma, writeTree, type Sandbox } from "./cli-harness.js";
import { hasTool, mentions, RoutedProvider, type Route } from "./routed-provider.js";

registerCleanup();

let counter = 0;

function call(name: string, input: unknown): ScriptStep {
  counter += 1;
  return { respond: { parts: [{ type: "tool-call", id: `call-${String(counter)}`, name, input }] } };
}

function stateDir(sandbox: Sandbox, name: string): string {
  return path.join(sandbox.bmaHome, "state", "projects", projectKey(sandbox.workspace), name);
}

function answers(...texts: string[]): ScriptedProvider {
  return new ScriptedProvider(
    texts.map((text) => ({ respond: { text } })),
    { id: "claude" },
  );
}

interface TaskLine {
  readonly id: string;
  readonly status: string;
  readonly mode: string;
  readonly dependencies: readonly string[];
  readonly acceptance: readonly string[];
}

async function addTask(sandbox: Sandbox, args: readonly string[], minute: number): Promise<string> {
  const result = await runBma(sandbox, ["task", "add", ...args, "--json"], { now: new Date(Date.UTC(2026, 10, 23, 8, minute)) });
  expect(result.stderr.text).toBe("");
  expect(result.code).toBe(EXIT_OK);
  const line = result.stdout.jsonLines().at(-1);
  expect(line?.["type"]).toBe("task-added");
  return (line?.["task"] as TaskLine).id;
}

async function listTasks(sandbox: Sandbox): Promise<TaskLine[]> {
  const result = await runBma(sandbox, ["task", "list", "--json"]);
  expect(result.code).toBe(EXIT_OK);
  return result.stdout.jsonLines().at(-1)?.["tasks"] as TaskLine[];
}

function teamRoutes(name: string, task: string, file: string): Route[] {
  const planTitle = `${name} plan`;
  return [
    {
      name: `${name}-lead`,
      match: (request) => hasTool(request, "submit_plan") && mentions(request, task),
      script: new ScriptedProvider([
        call("submit_plan", {
          title: planTitle,
          summary: `Create ${file}.`,
          steps: [{ id: "1", title: "Write the file", detail: `${file} exists.` }],
          inScope: ["src/**"],
          outOfScope: [],
          verify: [{ argv: ["node", "-e", `require('fs').accessSync('${file}')`] }],
          stopConditions: [],
          acceptance: [`${file} exists`],
        }),
      ]),
    },
    {
      name: `${name}-executor`,
      match: (request) => hasTool(request, "submit_result") && mentions(request, planTitle),
      script: new ScriptedProvider([call("write_file", { path: file, content: `${name}\n` }), call("submit_result", { summary: `Added ${file}.` })]),
    },
    {
      name: `${name}-reviewer`,
      match: (request) => hasTool(request, "submit_review") && mentions(request, planTitle),
      script: new ScriptedProvider([call("submit_review", { verdict: "approve", criteria: { AC1: { status: "PASS", note: "Read it." } }, findings: [], summary: "Right." })]),
    },
  ];
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

describe("bma task", () => {
  it("adds, lists, shows and cancels tasks", async () => {
    const sandbox = makeSandbox();
    const first = await addTask(sandbox, ["Write the release notes", "--accept", "Notes list every change"], 0);
    const second = await addTask(sandbox, ["Summarise the notes", "--ask", "--after", first.slice(0, 10), "--title", "Summary"], 1);
    const tasks = await listTasks(sandbox);
    expect(tasks).toMatchObject([
      { id: first, status: "open", mode: "team", acceptance: ["Notes list every change"], dependencies: [] },
      { id: second, status: "open", mode: "ask", dependencies: [first] },
    ]);
    const list = await runBma(sandbox, ["task"]);
    expect(list.stdout.text).toContain(`${second}  open         ask   Summary (after ${first})`);
    const show = await runBma(sandbox, ["task", "show", second]);
    expect(show.stdout.text).toContain("mode: ask");
    expect(show.stdout.text).toContain(`after: ${first} (open)`);
    expect(show.stdout.text).toContain("  Summarise the notes");
    expect((await runBma(sandbox, ["task", "cancel", first])).code).toBe(EXIT_OK);
    expect((await runBma(sandbox, ["task", "cancel", first])).code).toBe(EXIT_USAGE);
    const cancelled = await runBma(sandbox, ["task", "list", "--status", "cancelled", "--json"]);
    expect((cancelled.stdout.jsonLines().at(-1)?.["tasks"] as TaskLine[]).map((task) => task.id)).toEqual([first]);
    const blocked = await runBma(sandbox, ["task", "add", "Later", "--after", first]);
    expect(blocked.code).toBe(EXIT_USAGE);
    expect(blocked.stderr.text).toContain("is cancelled");
  });

  it("validates task arguments", async () => {
    const sandbox = makeSandbox();
    const cases: readonly (readonly string[])[] = [
      ["task", "add"],
      ["task", "add", "Answer it", "--ask", "--accept", "Correct"],
      ["task", "add", "Do it", "--accept", " "],
      ["task", "add", "Do it", "--after", "01ZZZZZZ"],
      ["task", "add", "Do it", "--title", " "],
      ["task", "list", "--status", "sleeping"],
      ["task", "show"],
      ["task", "run", "01ZZZZZZ", "--all"],
      ["task", "run", "--parallel", "2"],
      ["task", "run", "--all", "--parallel", "5"],
      ["task", "run", "--all", "--parallel", "1.5"],
      ["task", "frobnicate"],
    ];
    for (const argv of cases) {
      expect((await runBma(sandbox, argv)).code, argv.join(" ")).toBe(EXIT_USAGE);
    }
  });

  it("runs ready ask tasks in dependency order and links runs to tasks in the audit ledger", async () => {
    const sandbox = makeSandbox();
    const first = await addTask(sandbox, ["What does the README say?", "--ask"], 0);
    const second = await addTask(sandbox, ["Summarise that answer", "--ask", "--after", first], 1);
    const early = await runBma(sandbox, ["task", "run", second]);
    expect(early.code).toBe(EXIT_USAGE);
    expect(early.stderr.text).toContain(`waits for ${first}`);
    const provider = answers("It says demo.", "A demo.");
    const result = await runBma(sandbox, ["task", "run", "--all", "--json"], { providers: { claude: provider } });
    expect(result.code).toBe(EXIT_OK);
    provider.assertDone();
    const runs = result.stdout.jsonLines().filter((line) => line["type"] === "task-run");
    expect(runs.map((line) => [line["taskId"], line["status"]])).toEqual([
      [first, "done"],
      [second, "done"],
    ]);
    expect((await listTasks(sandbox)).map((task) => task.status)).toEqual(["done", "done"]);
    const records = await readAuditLedger(stateDir(sandbox, "audit"), () => undefined);
    const starts = records.flatMap((record) => (record.kind === "run-start" ? [[record.command, record.taskId]] : []));
    expect(starts).toEqual([
      ["run", first],
      ["run", second],
    ]);
    const idle = await runBma(sandbox, ["task", "run"]);
    expect(idle.code).toBe(EXIT_OK);
    expect(idle.stderr.text).toContain("no ready task");
  });

  it("marks tasks left running by an interrupted runner as failed", async () => {
    const sandbox = makeSandbox();
    const id = await addTask(sandbox, ["Answer it", "--ask"], 0);
    appendFileSync(
      path.join(stateDir(sandbox, "tasks"), "tasks.jsonl"),
      `${JSON.stringify({ v: 1, ts: new Date().toISOString(), type: "status", id, status: "running" })}\n`,
    );
    const result = await runBma(sandbox, ["task", "run"]);
    expect(result.code).toBe(EXIT_OK);
    expect(result.stderr.text).toContain("no ready task");
    const show = await runBma(sandbox, ["task", "show", id]);
    expect(show.stdout.text).toContain(`task ${id}: failed`);
    expect(show.stdout.text).toContain("failed: interrupted");
  });

  it("refuses to start while another runner holds the lock", async () => {
    const sandbox = makeSandbox();
    await addTask(sandbox, ["Answer it", "--ask"], 0);
    const lockFile = path.join(stateDir(sandbox, "tasks"), "runner.lock");
    writeTree(stateDir(sandbox, "tasks"), {
      "runner.lock": JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: "2026-11-23T08:00:00.000Z" }),
    });
    const result = await runBma(sandbox, ["task", "run"], { providers: { claude: answers("unused") } });
    expect(result.code).toBe(EXIT_FAILED);
    expect(result.stderr.text).toContain("another task runner is active");
    expect(readFileSync(lockFile, "utf8")).toContain(String(process.pid));
  });

  it("runs independent team tasks in parallel and an ask task alone once its dependency is done", { timeout: 90_000 }, async () => {
    const sandbox = makeSandbox();
    prepareRepo(sandbox);
    expect((await runBma(sandbox, ["trust"], { stdin: "y\n", stdinIsTTY: true, stderrIsTTY: true })).code).toBe(EXIT_OK);
    const alpha = await addTask(sandbox, ["Add the alpha file"], 0);
    const beta = await addTask(sandbox, ["Add the beta file"], 1);
    const summary = await addTask(sandbox, ["Summarise the alpha work", "--ask", "--after", alpha], 2);
    const provider = new RoutedProvider(
      "claude",
      [
        ...teamRoutes("alpha", "Add the alpha file", "src/alpha.txt"),
        ...teamRoutes("beta", "Add the beta file", "src/beta.txt"),
        {
          name: "summary",
          match: (request) => mentions(request, "Summarise the alpha work"),
          script: new ScriptedProvider([{ respond: { text: "The alpha file was added." } }]),
        },
      ],
      { overlap: ["alpha-lead", "beta-lead"] },
    );
    const result = await runBma(sandbox, ["task", "run", "--all", "--parallel", "2", "--yes-verify", "--json"], { providers: { claude: provider } });
    expect(result.stderr.text).toBe("");
    expect(result.code).toBe(EXIT_OK);
    provider.assertDone();
    const lines = result.stdout.jsonLines();
    const outcomes = lines.filter((line) => line["type"] === "team-outcome").map((line) => line["outcome"] as { status: string; branch: string });
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["approved", "approved"]);
    expect(new Set(outcomes.map((outcome) => outcome.branch)).size).toBe(2);
    const runs = lines.filter((line) => line["type"] === "task-run").map((line) => [line["taskId"], line["status"]]);
    expect(runs).toHaveLength(3);
    expect(runs.at(-1)).toEqual([summary, "done"]);
    expect(runs.slice(0, 2)).toEqual(expect.arrayContaining([
      [alpha, "done"],
      [beta, "done"],
    ]));
    expect((await listTasks(sandbox)).map((task) => task.status)).toEqual(["done", "done", "done"]);
    expect(git(sandbox.workspace, ["status", "--porcelain"], sandbox.env)).toBe("");
  });

  it("runs a team task with its acceptance criteria", { timeout: 60_000 }, async () => {
    const sandbox = makeSandbox();
    prepareRepo(sandbox);
    expect((await runBma(sandbox, ["trust"], { stdin: "y\n", stdinIsTTY: true, stderrIsTTY: true })).code).toBe(EXIT_OK);
    const id = await addTask(sandbox, ["Add a hello file", "--accept", "src/hello.txt contains hello"], 0);
    const provider = new ScriptedProvider(
      [
        call("submit_plan", {
          title: "Add hello file",
          summary: "Create src/hello.txt.",
          steps: [{ id: "1", title: "Write the file", detail: "src/hello.txt contains hello." }],
          inScope: ["src/**"],
          outOfScope: [],
          verify: [{ argv: ["node", "-e", "require('fs').accessSync('src/hello.txt')"] }],
          stopConditions: [],
          acceptance: [],
        }),
        call("write_file", { path: "src/hello.txt", content: "hello\n" }),
        call("submit_result", { summary: "Added src/hello.txt." }),
        call("submit_review", { verdict: "approve", criteria: { AC1: { status: "PASS", note: "Read it." } }, findings: [], summary: "Right." }),
      ],
      { id: "claude" },
    );
    const result = await runBma(sandbox, ["task", "run", "--yes-verify", "--json"], { providers: { claude: provider } });
    provider.assertDone();
    expect(JSON.stringify(provider.requests[0]?.history)).toContain("src/hello.txt contains hello");
    const lines = result.stdout.jsonLines();
    const outcome = lines.find((line) => line["type"] === "team-outcome")?.["outcome"] as { runId: string; status: string };
    expect(outcome.status).toBe("approved");
    expect(lines.at(-1)).toMatchObject({ type: "task-run", taskId: id, status: "done", runId: outcome.runId });
    expect(result.code).toBe(EXIT_OK);
    const show = await runBma(sandbox, ["task", "show", id]);
    expect(show.stdout.text).toContain(`done: run ${outcome.runId}`);
  });
});
