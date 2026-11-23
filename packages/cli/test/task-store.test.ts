import { createRedactor } from "@betamultiagent/core";
import { appendFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { acquireRunnerLock, LOCK_FILE, RunnerLockError, type LockEnvironment } from "../src/tasks/runner-lock.js";
import { findTask, isReady, TaskLookupError, TaskStore, type TaskSpec, type TaskState } from "../src/tasks/task-store.js";
import { makeTempDir, registerCleanup, writeTree } from "./cli-harness.js";

registerCleanup();

const SECRET = "sk-ant-test-0123456789abcdefghij";
const NOW = new Date("2026-11-23T08:00:00Z");

function spec(id: string, overrides: Partial<TaskSpec> = {}): TaskSpec {
  return { id, title: `task ${id}`, goal: `do ${id}`, mode: "team", acceptance: [], dependencies: [], createdAt: NOW.toISOString(), ...overrides };
}

function openStore(dir: string, warnings: string[] = []): TaskStore {
  return new TaskStore(dir, createRedactor(), () => NOW, (message) => warnings.push(message));
}

describe("task store", () => {
  it("folds added and status events into the current state with history", async () => {
    const dir = makeTempDir();
    const store = openStore(dir);
    await store.add(spec("01B"));
    await store.add(spec("01A", { goal: `use ${SECRET}` }));
    await store.setStatus({ id: "01A", status: "running" });
    await store.setStatus({ id: "01A", status: "failed", runId: "run-1", code: "verify-failed", message: "tests failed" });
    const tasks = await store.load();
    expect(tasks.map((task) => [task.id, task.status])).toEqual([
      ["01A", "failed"],
      ["01B", "open"],
    ]);
    expect(tasks[0]?.goal).toBe("use [REDACTED]");
    expect(tasks[0]?.history).toEqual([
      { ts: NOW.toISOString(), status: "running" },
      { ts: NOW.toISOString(), status: "failed", runId: "run-1", code: "verify-failed", message: "tests failed" },
    ]);
    expect(readFileSync(store.file, "utf8")).not.toContain(SECRET);
  });

  it("returns no tasks before the first event", async () => {
    expect(await openStore(path.join(makeTempDir(), "tasks")).load()).toEqual([]);
  });

  it("skips malformed lines, duplicates and unknown task ids with warnings", async () => {
    const dir = makeTempDir();
    const warnings: string[] = [];
    const store = openStore(dir, warnings);
    await store.add(spec("01A"));
    appendFileSync(store.file, "not json\n{\"v\":1}\n");
    await store.add(spec("01A", { title: "again" }));
    await store.setStatus({ id: "01Z", status: "done" });
    const tasks = await store.load();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.title).toBe("task 01A");
    expect(warnings).toEqual([
      "tasks.jsonl:2: skipped unparsable task event",
      "tasks.jsonl:3: skipped invalid task event",
      "duplicate task 01A ignored",
      "status for unknown task 01Z ignored",
    ]);
  });

  it("rejects tasks that break the schema before writing", async () => {
    const store = openStore(makeTempDir());
    await expect(store.add(spec("01A", { title: "" }))).rejects.toThrow();
    expect(await store.load()).toEqual([]);
  });
});

describe("task lookup and readiness", () => {
  const state = (id: string, status: TaskState["status"], dependencies: string[] = []): TaskState => ({
    ...spec(id, { dependencies }),
    status,
    updatedAt: NOW.toISOString(),
    history: [],
  });

  it("finds tasks by full id or unique prefix", () => {
    const tasks = [state("01JABCD0001", "open"), state("01JABCE0002", "open")];
    expect(findTask(tasks, "01JABCE0002").id).toBe("01JABCE0002");
    expect(findTask(tasks, "01jabce").id).toBe("01JABCE0002");
    expect(() => findTask(tasks, "01JABC")).toThrow(/ambiguous/u);
    expect(() => findTask(tasks, "01J")).toThrow(TaskLookupError);
    expect(() => findTask(tasks, "ZZZZ")).toThrow(/no task matches/u);
  });

  it("treats an open task as ready only when every dependency is done", () => {
    const tasks = [state("A", "done"), state("B", "failed"), state("C", "open", ["A"]), state("D", "open", ["A", "B"]), state("E", "failed", ["A"])];
    expect(tasks.filter((task) => isReady(task, tasks)).map((task) => task.id)).toEqual(["C"]);
  });
});

describe("task runner lock", () => {
  function environment(overrides: Partial<LockEnvironment> = {}): LockEnvironment {
    return { pid: 4242, hostname: os.hostname(), now: () => NOW, isAlive: () => true, ...overrides };
  }

  it("is exclusive while held and released by its owner", async () => {
    const dir = makeTempDir();
    const lock = await acquireRunnerLock(dir, environment());
    await expect(acquireRunnerLock(dir, environment({ pid: 4343 }))).rejects.toThrow(/pid 4242/u);
    await lock.release();
    const next = await acquireRunnerLock(dir, environment({ pid: 4343 }));
    expect(next.replaced).toBeUndefined();
    await next.release();
  });

  it("replaces a lock whose process has exited on the same host", async () => {
    const dir = makeTempDir();
    await acquireRunnerLock(dir, environment());
    const lock = await acquireRunnerLock(dir, environment({ pid: 4343, isAlive: () => false }));
    expect(lock.replaced).toMatchObject({ pid: 4242 });
    expect(JSON.parse(readFileSync(path.join(dir, LOCK_FILE), "utf8"))).toMatchObject({ pid: 4343 });
  });

  it("refuses a lock held on another host or with an unreadable owner", async () => {
    const remote = makeTempDir();
    await acquireRunnerLock(remote, environment({ hostname: "elsewhere" }));
    await expect(acquireRunnerLock(remote, environment({ pid: 4343, isAlive: () => false }))).rejects.toThrow(RunnerLockError);
    const broken = makeTempDir();
    writeTree(broken, { [LOCK_FILE]: "garbage" });
    await expect(acquireRunnerLock(broken, environment())).rejects.toThrow(/cannot be read/u);
  });

  it("does not remove a lock that another runner took over", async () => {
    const dir = makeTempDir();
    const stale = await acquireRunnerLock(dir, environment());
    await acquireRunnerLock(dir, environment({ pid: 4343, isAlive: () => false }));
    await stale.release();
    expect(JSON.parse(readFileSync(path.join(dir, LOCK_FILE), "utf8"))).toMatchObject({ pid: 4343 });
  });
});
