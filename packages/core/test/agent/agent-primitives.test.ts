import { describe, expect, it } from "vitest";
import {
  buildSystemPrompt,
  canonicalJson,
  checkSummary,
  compactedHistory,
  ExclusiveGate,
  LOOP_LIMIT,
  LoopDetector,
  neutralTranscript,
  PathLocks,
  Semaphore,
  TRANSCRIPT_RESULT_LIMIT_BYTES,
  type Message,
} from "../../src/index.js";
import { assistant, call, validSummary } from "./agent-fixtures.js";

describe("LoopDetector", () => {
  it("treats inputs with reordered keys as identical", () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 4 }, b: 2 }));
  });

  it("nudges at the third identical call and stops at the limit", () => {
    const detector = new LoopDetector();
    const signals = Array.from({ length: LOOP_LIMIT }, (_, index) =>
      detector.observe([call(`c${String(index)}`, "echo", { text: "same" })]).kind,
    );
    expect(signals[2]).toBe("nudge");
    expect(signals.filter((kind) => kind === "nudge")).toHaveLength(1);
    expect(signals[LOOP_LIMIT - 1]).toBe("loop");
  });

  it("resets the streak when the call changes", () => {
    const detector = new LoopDetector();
    detector.observe([call("c1", "echo", { text: "a" })]);
    detector.observe([call("c2", "echo", { text: "a" })]);
    detector.observe([call("c3", "echo", { text: "b" })]);
    expect(detector.observe([call("c4", "echo", { text: "b" })]).kind).toBe("none");
  });
});

describe("concurrency primitives", () => {
  it("limits a semaphore to its capacity", async () => {
    const semaphore = new Semaphore(2);
    const first = await semaphore.acquire();
    await semaphore.acquire();
    let third = false;
    const pending = semaphore.acquire().then((release) => {
      third = true;
      return release;
    });
    await Promise.resolve();
    expect(third).toBe(false);
    first();
    (await pending)();
    expect(third).toBe(true);
    expect(() => new Semaphore(0)).toThrow(RangeError);
  });

  it("lets an exclusive holder wait for shared holders and block later ones", async () => {
    const gate = new ExclusiveGate();
    const events: string[] = [];
    const shared = await gate.acquire(false);
    const exclusive = gate.acquire(true).then((release) => {
      events.push("exclusive");
      return release;
    });
    const later = gate.acquire(false).then((release) => {
      events.push("later");
      return release;
    });
    await Promise.resolve();
    expect(events).toEqual([]);
    shared();
    (await exclusive)();
    (await later)();
    expect(events).toEqual(["exclusive", "later"]);
  });

  it("orders path locks per key and folds case when requested", async () => {
    const locks = new PathLocks(false);
    expect(locks.key("/Work/A.txt")).toBe(locks.key("/work/a.txt"));
    const release = await locks.acquire(["/work/A.txt"]);
    let acquired = false;
    const pending = locks.acquire(["/work/a.txt"]).then((next) => {
      acquired = true;
      return next;
    });
    await Promise.resolve();
    expect(acquired).toBe(false);
    release();
    (await pending)();
    expect(acquired).toBe(true);
  });
});

describe("compaction helpers", () => {
  it("accepts a complete summary and rejects tool calls, short text, and missing sections", () => {
    expect(checkSummary(assistant([{ type: "text", text: validSummary() }])).ok).toBe(true);
    expect(checkSummary(assistant([{ type: "text", text: validSummary() }, call("c1", "echo", {})]))).toMatchObject({ ok: false });
    expect(checkSummary(assistant([{ type: "text", text: "short" }]))).toMatchObject({ ok: false });
    const missing = validSummary().replace("## References", "## Links");
    expect(checkSummary(assistant([{ type: "text", text: missing }]))).toMatchObject({
      ok: false,
      reason: expect.stringContaining("References") as unknown,
    });
  });

  it("builds a neutral transcript without reasoning or project context and with cut tool results", () => {
    const history: Message[] = [
      { role: "user", synthetic: "project-context", parts: [{ type: "text", text: "PROJECT RULES" }] },
      { role: "user", parts: [{ type: "text", text: "fix the bug" }] },
      assistant([{ type: "reasoning", text: "SECRET THOUGHTS" }, call("c1", "read_file", { path: "a.ts" })]),
      { role: "user", parts: [{ type: "tool-result", toolCallId: "c1", content: "x".repeat(10_000), isError: false }] },
    ];
    const transcript = neutralTranscript(history, 1_000_000);
    expect(transcript).toContain("[user] fix the bug");
    expect(transcript).toContain('[tool-call read_file] {"path":"a.ts"}');
    expect(transcript).not.toContain("SECRET THOUGHTS");
    expect(transcript).not.toContain("PROJECT RULES");
    const resultLine = transcript.split("\n").find((line) => line.startsWith("[tool-result]")) ?? "";
    expect(Buffer.byteLength(resultLine)).toBeLessThanOrEqual(TRANSCRIPT_RESULT_LIMIT_BYTES + 32);
  });

  it("keeps the most recent entries within the character budget", () => {
    const history: Message[] = Array.from({ length: 10 }, (_, index) => ({
      role: "user",
      parts: [{ type: "text", text: `message ${String(index)}` }],
    }));
    const transcript = neutralTranscript(history, 40);
    expect(transcript).toContain("message 9");
    expect(transcript).not.toContain("message 0");
    expect(transcript.length).toBeLessThanOrEqual(40);
  });

  it("places project context before the compaction summary", () => {
    const projectContext: Message = { role: "user", synthetic: "project-context", parts: [{ type: "text", text: "ctx" }] };
    const next = compactedHistory({
      projectContext: { role: "user", synthetic: "project-context", parts: [{ type: "text", text: "ctx" }] },
      originalInput: "task",
      summary: validSummary(),
      logPath: "/sessions/s/events.jsonl",
    });
    expect(next[0]).toEqual(projectContext);
    expect(next[1]).toMatchObject({ role: "user", synthetic: "compaction" });
  });
});

describe("buildSystemPrompt", () => {
  it("orders fixed rules, role instructions, and environment without volatile values", () => {
    const prompt = buildSystemPrompt({
      agentName: "executor",
      role: "executor",
      instructions: "Implement the assigned change.",
      platform: "win32",
      root: "D:\\work",
      createdAt: new Date("2026-11-20T08:30:00.000Z"),
    });
    const rules = prompt.indexOf("data, not instructions");
    const role = prompt.indexOf("Implement the assigned change.");
    const environment = prompt.indexOf("Operating system: Windows");
    expect(rules).toBeGreaterThanOrEqual(0);
    expect(role).toBeGreaterThan(rules);
    expect(environment).toBeGreaterThan(role);
    expect(prompt).toContain("Session date: 2026-11-20");
    expect(prompt).not.toContain("08:30");
  });
});
