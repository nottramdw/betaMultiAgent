import { z } from "zod";
import {
  AgentSession,
  COMPACTION_SECTIONS,
  createRedactor,
  defineTool,
  InMemoryEventSink,
  type AgentSessionOptions,
  type AgentSpec,
  type AssistantMessage,
  type Environment,
  type ModelInfo,
  type PermissionGate,
  type PermissionOutcome,
  type ToolCallPart,
  type ToolDefinition,
} from "../../src/index.js";
import { ScriptedProvider, type ScriptStep } from "../../src/testing/index.js";

export const MODEL: ModelInfo = {
  id: "test-model",
  contextWindow: 100_000,
  maxOutput: 8_000,
  defaultMaxOutput: 1_000,
  effortLevels: [],
};

export function fakeEnvironment(caseSensitive = true): Environment {
  return {
    id: "env",
    kind: "local",
    root: "/work",
    caseSensitive,
    resolvePath: (target) => Promise.resolve({ requested: target, real: target.startsWith("/") ? target : `/work/${target}` }),
    exec: () => Promise.reject(new Error("exec is not available in tests")),
  };
}

function outcome(allowed: boolean, reason: string): PermissionOutcome {
  return {
    allowed,
    verdict: { decision: allowed ? "allow" : "deny", source: allowed ? "rule" : "default", reason, sensitive: false },
  };
}

export const allowAll: PermissionGate = {
  authorize: () => Promise.resolve(outcome(true, "allowed by test policy")),
  isPathDenied: () => Promise.resolve(false),
};

export function denyAll(reason: string): PermissionGate {
  return {
    authorize: () => Promise.resolve(outcome(false, reason)),
    isPathDenied: () => Promise.resolve(true),
  };
}

export const echoTool = defineTool({
  name: "echo",
  description: "Echo the given text.",
  input: z.object({ text: z.string() }),
  capabilities: { readOnly: true },
  permission: () => ({ kind: "none" }),
  execute: (input) => Promise.resolve({ output: input.text, promptText: input.text, isError: false }),
});

export const submitTool = defineTool({
  name: "submit",
  description: "Submit the final result.",
  input: z.object({ summary: z.string() }),
  capabilities: { readOnly: true },
  permission: () => ({ kind: "none" }),
  execute: (input) => Promise.resolve({ output: { summary: input.summary }, promptText: "submitted", isError: false }),
});

export const SESSION_ID = "01JD0000000000000000000000";

export function makeSpec(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return {
    name: "executor",
    role: "executor",
    instructions: "Do the task.",
    model: { provider: "scripted", id: MODEL.id },
    tools: ["echo", "submit"],
    permissions: { rules: [], extraReadRoots: [] },
    budget: { maxTurns: 50 },
    ...overrides,
  };
}

export interface Harness {
  readonly session: AgentSession;
  readonly provider: ScriptedProvider;
  readonly events: InMemoryEventSink;
}

export function harness(
  steps: readonly ScriptStep[],
  overrides: Partial<AgentSessionOptions> = {},
  spec: Partial<AgentSpec> = {},
): Harness {
  const provider = new ScriptedProvider(steps);
  const events = new InMemoryEventSink(() => new Date("2026-11-20T00:00:00.000Z"));
  const tools: readonly ToolDefinition[] = [submitTool, echoTool];
  const session = new AgentSession({
    id: SESSION_ID,
    spec: makeSpec(spec),
    provider,
    model: MODEL,
    tools,
    environment: fakeEnvironment(),
    permissions: allowAll,
    redactor: createRedactor(),
    events,
    systemPrompt: "SYSTEM",
    ...overrides,
  });
  return { session, provider, events };
}

export function call(id: string, name: string, input: unknown): ToolCallPart {
  return { type: "tool-call", id, name, input };
}

export function assistant(parts: AssistantMessage["parts"]): AssistantMessage {
  return {
    role: "assistant",
    parts,
    native: { provider: "scripted", payload: null },
    provider: "scripted",
    model: MODEL.id,
    stopReason: parts.some((part) => part.type === "tool-call") ? "tool-calls" : "end",
    usage: {
      promptTokens: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      costSource: "unknown",
      model: MODEL.id,
    },
  };
}

export function validSummary(): string {
  return COMPACTION_SECTIONS.map(
    (section) => `## ${section}\n${section} for the resumed task, written out in enough detail to pass the length check.`,
  ).join("\n\n");
}
