import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  createRedactor,
  defineTool,
  InMemoryFileStateStore,
  ToolRuntime,
  type EventBody,
  type PermissionGate,
  type PermissionRequest,
  type ToolCapabilities,
  type ToolDefinition,
} from "../../src/index.js";
import { allowAll, call, denyAll, echoTool, fakeEnvironment, submitTool } from "./agent-fixtures.js";

interface Tracker {
  active: number;
  peak: number;
  readonly order: string[];
}

function tracker(): Tracker {
  return { active: 0, peak: 0, order: [] };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trackedTool(
  name: string,
  track: Tracker,
  capabilities: ToolCapabilities,
  permission: (input: { path: string }) => PermissionRequest = () => ({ kind: "none" }),
): ToolDefinition<{ path: string }, string> {
  return defineTool({
    name,
    description: `Tracked tool ${name}.`,
    input: z.object({ path: z.string() }),
    capabilities,
    permission,
    execute: async (input) => {
      track.active += 1;
      track.peak = Math.max(track.peak, track.active);
      track.order.push(`start:${name}:${input.path}`);
      await delay(15);
      track.order.push(`end:${name}:${input.path}`);
      track.active -= 1;
      return { output: input.path, promptText: input.path, isError: false };
    },
  });
}

function runtime(
  tools: readonly ToolDefinition[],
  options: { readonly permissions?: PermissionGate; readonly caseSensitive?: boolean; readonly completionTool?: string } = {},
): { readonly runtime: ToolRuntime; readonly emitted: EventBody[] } {
  const emitted: EventBody[] = [];
  return {
    emitted,
    runtime: new ToolRuntime({
      tools,
      permissions: options.permissions ?? allowAll,
      environment: fakeEnvironment(options.caseSensitive ?? true),
      fileState: new InMemoryFileStateStore(),
      redactor: createRedactor(),
      sessionId: "session",
      agentName: "executor",
      depth: 0,
      ...(options.completionTool === undefined ? {} : { completionTool: options.completionTool }),
      emit: (body) => {
        emitted.push(body);
        return Promise.resolve();
      },
    }),
  };
}

const signal = new AbortController().signal;

describe("ToolRuntime validation", () => {
  it("returns INVALID_INPUT for unknown tools, unparsable JSON, and schema failures without executing", async () => {
    const { runtime: tools, emitted } = runtime([echoTool]);
    const batch = await tools.execute(
      [
        call("c1", "missing", {}),
        { type: "tool-call", id: "c2", name: "echo", input: {}, inputError: "invalid-json" },
        call("c3", "echo", { text: 42 }),
      ],
      signal,
    );
    expect(batch.results.map((result) => result.isError)).toEqual([true, true, true]);
    for (const result of batch.results) {
      expect(JSON.parse(result.content)).toHaveProperty("INVALID_INPUT");
    }
    expect(batch.results[2]?.content).toContain("text");
    expect(emitted.some((body) => body.type === "tool-start")).toBe(false);
  });

  it("reports the policy reason when permission is denied", async () => {
    const track = tracker();
    const writer = trackedTool("write_file", track, { readOnly: false }, (input) => ({ kind: "write", paths: [input.path] }));
    const { runtime: tools, emitted } = runtime([writer], { permissions: denyAll("outside the workspace") });
    const batch = await tools.execute([call("c1", "write_file", { path: "a.txt" })], signal);
    expect(batch.results[0]).toMatchObject({ isError: true, content: "Permission denied by policy: outside the workspace" });
    expect(track.order).toEqual([]);
    expect(emitted.find((body) => body.type === "permission")).toMatchObject({ allowed: false });
  });

  it("checks permissions sequentially in call order", async () => {
    const seen: string[] = [];
    let pending = 0;
    let overlapped = false;
    const gate: PermissionGate = {
      authorize: async (request) => {
        pending += 1;
        overlapped ||= pending > 1;
        seen.push(request.kind === "write" ? request.paths.join(",") : request.kind);
        await delay(5);
        pending -= 1;
        return { allowed: true, verdict: { decision: "allow", source: "rule", reason: "ok", sensitive: false } };
      },
      isPathDenied: () => Promise.resolve(false),
    };
    const writer = trackedTool("write_file", tracker(), { readOnly: false }, (input) => ({ kind: "write", paths: [input.path] }));
    const { runtime: tools } = runtime([writer], { permissions: gate });
    await tools.execute(
      [call("c1", "write_file", { path: "1" }), call("c2", "write_file", { path: "2" }), call("c3", "write_file", { path: "3" })],
      signal,
    );
    expect(seen).toEqual(["1", "2", "3"]);
    expect(overlapped).toBe(false);
  });

  it("turns a thrown tool error into an error result", async () => {
    const failing = defineTool({
      name: "boom",
      description: "Always fails.",
      input: z.object({}),
      capabilities: { readOnly: true },
      permission: () => ({ kind: "none" }),
      execute: () => Promise.reject(new Error("exploded")),
    });
    const { runtime: tools, emitted } = runtime([failing]);
    const batch = await tools.execute([call("c1", "boom", {})], signal);
    expect(batch.results[0]).toMatchObject({ isError: true, content: "Tool failed: exploded" });
    expect(emitted.find((body) => body.type === "tool-end")).toMatchObject({ isError: true });
  });
});

describe("ToolRuntime scheduling", () => {
  it("runs independent read-only calls in parallel and keeps results in call order", async () => {
    const track = tracker();
    const reader = trackedTool("read_file", track, { readOnly: true });
    const { runtime: tools } = runtime([reader]);
    const batch = await tools.execute([call("c1", "read_file", { path: "a" }), call("c2", "read_file", { path: "b" })], signal);
    expect(track.peak).toBe(2);
    expect(batch.results.map((result) => result.toolCallId)).toEqual(["c1", "c2"]);
  });

  it("honours maxConcurrency", async () => {
    const track = tracker();
    const reader = trackedTool("read_file", track, { readOnly: true, maxConcurrency: 1 });
    const { runtime: tools } = runtime([reader]);
    await tools.execute(
      [call("c1", "read_file", { path: "a" }), call("c2", "read_file", { path: "b" }), call("c3", "read_file", { path: "c" })],
      signal,
    );
    expect(track.peak).toBe(1);
  });

  it("serializes writes to the same real path, ignoring case on case-insensitive file systems", async () => {
    const insensitive = tracker();
    const writerA = trackedTool("write_file", insensitive, { readOnly: false }, (input) => ({ kind: "write", paths: [input.path] }));
    await runtime([writerA], { caseSensitive: false }).runtime.execute(
      [call("c1", "write_file", { path: "A.txt" }), call("c2", "write_file", { path: "a.txt" })],
      signal,
    );
    expect(insensitive.peak).toBe(1);

    const sensitive = tracker();
    const writerB = trackedTool("write_file", sensitive, { readOnly: false }, (input) => ({ kind: "write", paths: [input.path] }));
    await runtime([writerB], { caseSensitive: true }).runtime.execute(
      [call("c1", "write_file", { path: "A.txt" }), call("c2", "write_file", { path: "a.txt" })],
      signal,
    );
    expect(sensitive.peak).toBe(2);
  });

  it("runs an exclusive tool alone, after earlier calls finish and before later calls start", async () => {
    const track = tracker();
    const reader = trackedTool("read_file", track, { readOnly: true });
    const exclusive = trackedTool("run_tests", track, { readOnly: true, exclusive: true });
    const { runtime: tools } = runtime([reader, exclusive]);
    await tools.execute(
      [call("c1", "read_file", { path: "a" }), call("c2", "run_tests", { path: "all" }), call("c3", "read_file", { path: "b" })],
      signal,
    );
    const startExclusive = track.order.indexOf("start:run_tests:all");
    const endExclusive = track.order.indexOf("end:run_tests:all");
    expect(track.order.indexOf("end:read_file:a")).toBeLessThan(startExclusive);
    expect(track.order.indexOf("start:read_file:b")).toBeGreaterThan(endExclusive);
  });
});

describe("ToolRuntime completion", () => {
  it("reports completion only when the completion tool is called alone and succeeds", async () => {
    const { runtime: tools } = runtime([echoTool, submitTool], { completionTool: "submit" });
    const alone = await tools.execute([call("c1", "submit", { summary: "done" })], signal);
    expect(alone.completion).toEqual({ result: { summary: "done" } });
    const mixed = await tools.execute([call("c2", "echo", { text: "x" }), call("c3", "submit", { summary: "done" })], signal);
    expect(mixed.completion).toBeUndefined();
    expect(mixed.results[1]).toMatchObject({ isError: true });
    expect(mixed.results[1]?.content).toContain("must be called alone");
  });
});
