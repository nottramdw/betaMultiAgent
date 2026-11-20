import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentConfigError,
  createRedactor,
  loadProjectContext,
  ProviderError,
  SessionClosedError,
  textOf,
  type Message,
  type ProjectContext,
  type ProviderRequest,
} from "../../src/index.js";
import { assistant, call, harness, SESSION_ID, validSummary } from "./agent-fixtures.js";

function messageText(message: Message | undefined): string {
  if (message === undefined) {
    return "";
  }
  return message.role === "system" ? message.text : textOf(message);
}

function lastOf(request: ProviderRequest): Message | undefined {
  return request.history[request.history.length - 1];
}

function assertPrefixes(requests: readonly ProviderRequest[]): void {
  for (let index = 0; index + 1 < requests.length; index += 1) {
    const current = requests[index]?.history ?? [];
    const next = requests[index + 1]?.history ?? [];
    expect(next.slice(0, current.length)).toEqual(current);
  }
}

function requestAt(requests: readonly ProviderRequest[], index: number): ProviderRequest {
  const request = requests[index];
  if (request === undefined) {
    throw new Error(`request ${String(index)} was not sent`);
  }
  return request;
}

const tempDirs: string[] = [];

async function projectContext(trusted: boolean, skillCatalog?: string): Promise<ProjectContext | undefined> {
  const root = await mkdtemp(path.join(os.tmpdir(), "bma-context-"));
  tempDirs.push(root);
  await writeFile(path.join(root, "AGENTS.md"), "Always use pnpm.\n", "utf8");
  return loadProjectContext({ root, trusted, ...(skillCatalog === undefined ? {} : { skillCatalog }) });
}

async function requireContext(): Promise<ProjectContext> {
  const context = await projectContext(true);
  if (context === undefined) {
    throw new Error("project context was not loaded");
  }
  return context;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("AgentSession basics", () => {
  it("completes a single text turn with a fixed request shape", async () => {
    const { session, provider, events } = harness([{ respond: { text: "done" } }]);
    await expect(session.run("hello")).resolves.toEqual({ type: "completed", text: "done" });
    expect(session.history.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(events.records.map((record) => record.type)).toEqual(["session-start", "message", "usage", "message", "outcome"]);
    const request = requestAt(provider.requests, 0);
    expect(request.system).toBe("SYSTEM");
    expect(request.tools.map((tool) => tool.name)).toEqual(["echo", "submit"]);
    expect(request.toolChoice).toBe("auto");
    expect(request.maxOutputTokens).toBe(1_000);
    expect(request.cacheKey).toBe(SESSION_ID);
    provider.assertDone();
  });

  it("returns tool results in call order within one message and keeps request prefixes stable", async () => {
    const { session, provider } = harness([
      { respond: { parts: [call("c1", "echo", { text: "one" }), call("c2", "echo", { text: "two" })] } },
      { respond: { parts: [call("c3", "echo", { text: "three" })] } },
      { respond: { text: "finished" } },
    ]);
    await expect(session.run("go")).resolves.toEqual({ type: "completed", text: "finished" });
    expect(session.history[2]).toEqual({
      role: "user",
      parts: [
        { type: "tool-result", toolCallId: "c1", content: "one", isError: false },
        { type: "tool-result", toolCallId: "c2", content: "two", isError: false },
      ],
    });
    expect(session.history).toHaveLength(6);
    assertPrefixes(provider.requests);
    provider.assertDone();
  });

  it("rejects a completion tool that is not among the session tools", () => {
    expect(() => harness([], {}, { completion: { tool: "missing" } })).toThrow(AgentConfigError);
  });
});

describe("AgentSession stop reasons", () => {
  it("fails after more than five consecutive pauses", async () => {
    const steps = Array.from({ length: 6 }, () => ({ respond: { text: "working", stopReason: "pause" as const } }));
    const { session, provider } = harness(steps);
    await expect(session.run("go")).resolves.toMatchObject({ type: "failed", code: "pause-limit" });
    expect(provider.requests).toHaveLength(6);
    expect(session.closed).toBe(true);
  });

  it("returns refused with stop details, keeps the turn out of history, and closes the session", async () => {
    const stopDetails = { category: "cyber", explanation: "declined" };
    const { session } = harness([{ respond: { text: "no", stopReason: "refusal", stopDetails } }]);
    await expect(session.run("go")).resolves.toEqual({ type: "refused", stopDetails });
    expect(session.history.map((message) => message.role)).toEqual(["user"]);
    await expect(session.run("again")).rejects.toBeInstanceOf(SessionClosedError);
  });

  it("resends a truncated tool call with a doubled output limit without executing it", async () => {
    const { session, provider, events } = harness([
      { respond: { parts: [call("c1", "echo", { text: "cut" })], stopReason: "max-tokens" } },
      {
        expect: (request) => {
          expect(request.maxOutputTokens).toBe(2_000);
        },
        respond: { parts: [call("c1", "echo", { text: "cut" })], stopReason: "max-tokens" },
      },
    ]);
    await expect(session.run("go")).resolves.toMatchObject({ type: "failed", code: "tool-input-truncated" });
    expect(session.history.map((message) => message.role)).toEqual(["user"]);
    expect(events.records.some((record) => record.type === "tool-start")).toBe(false);
    expect(requestAt(provider.requests, 1).history).toEqual(requestAt(provider.requests, 0).history);
  });

  it("restores the default output limit after a successful resend", async () => {
    const { session, provider } = harness([
      { respond: { parts: [call("c1", "echo", { text: "cut" })], stopReason: "max-tokens" } },
      { respond: { parts: [call("c1", "echo", { text: "whole" })] } },
      { respond: { text: "done" } },
    ]);
    await expect(session.run("go")).resolves.toEqual({ type: "completed", text: "done" });
    expect(provider.requests.map((request) => request.maxOutputTokens)).toEqual([1_000, 2_000, 1_000]);
  });

  it("appends a text turn that hits the output limit and reports max-tokens", async () => {
    const { session } = harness([{ respond: { text: "partial", stopReason: "max-tokens" } }]);
    await expect(session.run("go")).resolves.toEqual({ type: "max-tokens" });
    expect(session.history.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(session.closed).toBe(false);
  });

  it("fails after more than two consecutive interrupted streams", async () => {
    const steps = Array.from({ length: 3 }, () => ({ respond: new ProviderError("stream-interrupted", "cut") }));
    const { session, provider } = harness(steps);
    await expect(session.run("go")).resolves.toMatchObject({ type: "failed", code: "provider-stream-interrupted" });
    expect(provider.requests).toHaveLength(3);
  });

  it("maps other provider errors to failed outcomes", async () => {
    const { session } = harness([{ respond: new ProviderError("auth", "bad key") }]);
    await expect(session.run("go")).resolves.toMatchObject({ type: "failed", code: "provider-auth" });
  });
});

describe("AgentSession notes and loops", () => {
  it("keeps pending notes at the end of every resend until a turn is appended", async () => {
    const same = { text: "same" };
    const expectNudge = (request: ProviderRequest): void => {
      expect(lastOf(request)).toMatchObject({ role: "system", reason: "loop-nudge" });
    };
    const { session, provider } = harness([
      { respond: { parts: [call("c1", "echo", same)] } },
      { respond: { parts: [call("c2", "echo", same)] } },
      { respond: { parts: [call("c3", "echo", same)] } },
      { expect: expectNudge, respond: new ProviderError("stream-interrupted", "cut") },
      { expect: expectNudge, respond: { text: "changed approach" } },
    ]);
    await expect(session.run("go")).resolves.toEqual({ type: "completed", text: "changed approach" });
    expect(requestAt(provider.requests, 4)).toEqual(requestAt(provider.requests, 3));
    expect(session.history[7]).toMatchObject({ role: "system", reason: "loop-nudge" });
    expect(session.history[8]).toMatchObject({ role: "assistant" });
    expect(session.pendingNotes).toHaveLength(0);
    assertPrefixes(provider.requests);
  });

  it("detects a loop at twelve identical calls after nudging at the third", async () => {
    const steps = Array.from({ length: 12 }, (_, index) => ({
      respond: { parts: [call(`c${String(index)}`, "echo", { text: "same" })] },
    }));
    const { session, provider } = harness(steps);
    await expect(session.run("go")).resolves.toEqual({ type: "loop-detected", tool: "echo" });
    expect(session.history.filter((message) => message.role === "system")).toHaveLength(1);
    expect(session.closed).toBe(true);
    provider.assertDone();
  });
});

describe("AgentSession completion tool", () => {
  it("reminds twice and then fails when the completion tool is never called", async () => {
    const expectReminder = (request: ProviderRequest): void => {
      expect(lastOf(request)).toMatchObject({ role: "user", synthetic: "completion-reminder" });
    };
    const { session, provider } = harness(
      [
        { respond: { text: "a" } },
        { expect: expectReminder, respond: { text: "b" } },
        { expect: expectReminder, respond: { text: "c" } },
      ],
      {},
      { completion: { tool: "submit" } },
    );
    await expect(session.run("go")).resolves.toMatchObject({ type: "failed", code: "completion-missing" });
    provider.assertDone();
  });

  it("rejects a completion call made alongside other tools and accepts it alone", async () => {
    const { session } = harness(
      [
        { respond: { parts: [call("c1", "echo", { text: "x" }), call("c2", "submit", { summary: "early" })] } },
        { respond: { parts: [call("c3", "submit", { summary: "final" })] } },
      ],
      {},
      { completion: { tool: "submit" } },
    );
    await expect(session.run("go")).resolves.toMatchObject({ type: "completed", result: { summary: "final" } });
    const results = session.history[2];
    expect(results?.role === "user" ? results.parts : []).toMatchObject([
      { toolCallId: "c1", content: "x", isError: false },
      { toolCallId: "c2", isError: true },
    ]);
    expect(messageText(results)).toBe("");
  });

  it("answers dangling tool calls with synthetic results before the new input", async () => {
    const history: Message[] = [
      { role: "user", parts: [{ type: "text", text: "start" }] },
      assistant([call("c8", "submit", { summary: "s" }), call("c9", "echo", { text: "x" })]),
    ];
    const { session, provider, events } = harness(
      [{ respond: { parts: [call("c10", "submit", { summary: "done" })] } }],
      { history },
      { completion: { tool: "submit" } },
    );
    await session.run("continue");
    expect(requestAt(provider.requests, 0).history[2]).toEqual({
      role: "user",
      parts: [
        { type: "tool-result", toolCallId: "c8", content: "submitted", isError: false },
        { type: "tool-result", toolCallId: "c9", content: "interrupted", isError: true },
        { type: "text", text: "continue" },
      ],
    });
    expect(events.records.some((record) => record.type === "session-start")).toBe(false);
  });
});

describe("AgentSession budgets and abort", () => {
  it("stops when the turn budget is spent", async () => {
    const { session } = harness([{ respond: { parts: [call("c1", "echo", { text: "x" })] } }], {}, { budget: { maxTurns: 1 } });
    await expect(session.run("go")).resolves.toEqual({ type: "budget-exceeded", budget: "turns" });
    expect(session.closed).toBe(true);
  });

  it("stops when the cost budget is spent", async () => {
    const { session } = harness(
      [{ respond: { parts: [call("c1", "echo", { text: "x" })], usage: { costUsd: 1, costSource: "exact" } } }],
      {},
      { budget: { maxTurns: 10, maxCostUsd: 0.5 } },
    );
    await expect(session.run("go")).resolves.toEqual({ type: "budget-exceeded", budget: "cost" });
  });

  it("returns aborted when the signal fires mid-stream and leaves the session reusable", async () => {
    const controller = new AbortController();
    const { session } = harness([
      {
        respond: {
          parts: [
            { type: "text", text: "a" },
            { type: "text", text: "b" },
          ],
        },
      },
    ]);
    const outcome = await session.run("go", {
      signal: controller.signal,
      listeners: [
        {
          onDelta: () => {
            controller.abort();
          },
        },
      ],
    });
    expect(outcome).toEqual({ type: "aborted" });
    expect(session.history.map((message) => message.role)).toEqual(["user"]);
    expect(session.closed).toBe(false);
  });
});

describe("AgentSession compaction", () => {
  const overThreshold = { parts: [call("c1", "echo", { text: "x" })], usage: { promptTokens: 80_000 } };

  it("summarizes with a request identical to the main one plus the note, then replaces history", async () => {
    const { session, provider, events } = harness([
      { respond: overThreshold },
      { respond: { text: validSummary() } },
      { respond: { text: "after" } },
    ]);
    await expect(session.run("go")).resolves.toEqual({ type: "completed", text: "after" });
    const { history: mainHistory, ...main } = requestAt(provider.requests, 0);
    const { history: summaryHistory, ...summary } = requestAt(provider.requests, 1);
    expect(summary).toEqual(main);
    expect(summaryHistory.slice(0, mainHistory.length)).toEqual(mainHistory);
    expect(summaryHistory).toHaveLength(4);
    expect(summaryHistory[3]).toMatchObject({ role: "system", reason: "compaction" });
    const resumed = requestAt(provider.requests, 2).history;
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toMatchObject({ role: "user", synthetic: "compaction" });
    expect(messageText(resumed[0])).toContain("## Original task\ngo");
    expect(events.records.find((record) => record.type === "compaction")).toMatchObject({
      trigger: "threshold",
      replacedMessages: 3,
    });
  });

  it("retries the summary with tool choice none when the first answer calls a tool", async () => {
    const { session, provider } = harness([
      { respond: overThreshold },
      { respond: { parts: [call("c2", "echo", { text: "y" })] } },
      {
        expect: (request) => {
          expect(request.toolChoice).toBe("none");
        },
        respond: { text: validSummary() },
      },
      { respond: { text: "after" } },
    ]);
    await expect(session.run("go")).resolves.toEqual({ type: "completed", text: "after" });
    expect(requestAt(provider.requests, 1).toolChoice).toBe("auto");
    expect(requestAt(provider.requests, 3).history).toHaveLength(1);
  });

  it("keeps history and logs an error when both summaries are rejected", async () => {
    const { session, provider, events } = harness([
      { respond: overThreshold },
      { respond: { text: "too short" } },
      { respond: { text: "still short" } },
      { respond: { text: "done" } },
    ]);
    await expect(session.run("go")).resolves.toEqual({ type: "completed", text: "done" });
    expect(requestAt(provider.requests, 3).history).toHaveLength(3);
    expect(events.records.find((record) => record.type === "error")).toMatchObject({ code: "compaction-failed" });
  });

  it("rebuilds from a neutral transcript when the context is exceeded", async () => {
    const { session, provider } = harness([
      { respond: new ProviderError("context-exceeded", "too long") },
      {
        expect: (request) => {
          expect(request.toolChoice).toBe("none");
          expect(request.history).toHaveLength(1);
          const first = request.history[0];
          expect(messageText(first)).toContain("[user] go");
        },
        respond: { text: validSummary() },
      },
      { respond: { text: "recovered" } },
    ]);
    await expect(session.run("go")).resolves.toEqual({ type: "completed", text: "recovered" });
    expect(requestAt(provider.requests, 2).history[0]).toMatchObject({ synthetic: "compaction" });
  });

  it("fails with context-exceeded when the transcript summary is rejected", async () => {
    const { session } = harness([
      { respond: new ProviderError("context-exceeded", "too long") },
      { respond: { text: "short" } },
    ]);
    await expect(session.run("go")).resolves.toMatchObject({ type: "failed", code: "context-exceeded" });
  });
});

describe("AgentSession project context and redaction", () => {
  it("sends project context as the first synthetic message and keeps it first after compaction", async () => {
    const context = await requireContext();
    const { session, provider, events } = harness(
      [
        { respond: { parts: [call("c1", "echo", { text: "x" })], usage: { promptTokens: 80_000 } } },
        { respond: { text: validSummary() } },
        { respond: { text: "after" } },
      ],
      { projectContext: context },
    );
    await session.run("go");
    const first = requestAt(provider.requests, 0);
    expect(first.system).not.toContain("Always use pnpm.");
    expect(first.history[0]).toMatchObject({ role: "user", synthetic: "project-context" });
    expect(messageText(first.history[0])).toContain("Always use pnpm.");
    expect(events.records.find((record) => record.type === "context-loaded")).toMatchObject({ sources: ["AGENTS.md"] });
    const resumed = requestAt(provider.requests, 2).history;
    expect(resumed.map((message) => (message.role === "user" ? message.synthetic : undefined))).toEqual([
      "project-context",
      "compaction",
    ]);
  });

  it("does not load workspace files for an untrusted workspace", async () => {
    await expect(projectContext(false)).resolves.toBeUndefined();
    await expect(projectContext(false, "- skill: review")).resolves.toMatchObject({ sources: ["skill-catalog"] });
  });

  it("redacts secrets in tool results", async () => {
    const secret = "supersecretvalue123";
    const { session } = harness(
      [{ respond: { parts: [call("c1", "echo", { text: `token ${secret}` })] } }, { respond: { text: "ok" } }],
      { redactor: createRedactor({ secrets: [secret] }) },
    );
    await session.run("go");
    const results = session.history[2];
    const content = results?.role === "user" ? results.parts.map((part) => (part.type === "tool-result" ? part.content : "")) : [];
    expect(content.join("")).not.toContain(secret);
    expect(content.join("")).toContain("[REDACTED]");
  });
});
