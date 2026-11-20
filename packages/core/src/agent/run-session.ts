import { InMemoryFileStateStore, type Environment, type FileStateStore } from "../environment/environment.js";
import type { EventBody, EventListener, EventSink } from "../events/events.js";
import {
  textOf,
  toolCalls,
  type AssistantMessage,
  type Message,
  type SystemNote,
  type ToolResultPart,
  type UserMessage,
} from "../messages/messages.js";
import { ProviderError, type ModelInfo, type Provider, type ProviderRequest, type ToolChoice } from "../provider/provider.js";
import type { Redactor } from "../redaction/redaction.js";
import type { ToolDefinition } from "../tools/tool-definition.js";
import { toToolSpec, type ToolSpec } from "../tools/tool-spec.js";
import { checkBudget, UsageLedger } from "../usage/usage.js";
import type { AgentSpec, TurnOutcome } from "./agent-spec.js";
import {
  CHARS_PER_TOKEN,
  checkSummary,
  compactedHistory,
  compactionNote,
  neutralTranscript,
  transcriptRequestMessage,
  type SummaryCheck,
} from "./compaction.js";
import { LoopDetector } from "./loop-detector.js";
import type { ProjectContext } from "./system-prompt.js";
import { ToolRuntime, type PermissionGate } from "./tool-execution.js";

export const MAX_STREAM_RETRIES = 2;
export const MAX_PAUSES = 5;
export const MAX_COMPLETION_REMINDERS = 2;
export const COMPACTION_THRESHOLD = 0.7;
export const COMPACTION_INTERVAL_TURNS = 20;
export const TRANSCRIPT_WINDOW_SHARE = 0.5;

const TERMINAL_OUTCOMES: ReadonlySet<TurnOutcome["type"]> = new Set([
  "failed",
  "refused",
  "loop-detected",
  "budget-exceeded",
]);

export class SessionClosedError extends Error {
  constructor(sessionId: string) {
    super(`session ${sessionId} has ended and cannot run again`);
    this.name = "SessionClosedError";
  }
}

export class AgentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentConfigError";
  }
}

export interface AgentSessionOptions {
  readonly id: string;
  readonly spec: AgentSpec;
  readonly provider: Provider;
  readonly model: ModelInfo;
  readonly tools: readonly ToolDefinition[];
  readonly environment: Environment;
  readonly permissions: PermissionGate;
  readonly redactor: Redactor;
  readonly events: EventSink;
  readonly systemPrompt: string;
  readonly projectContext?: ProjectContext;
  readonly history?: readonly Message[];
  readonly ledger?: UsageLedger;
  readonly fileState?: FileStateStore;
  readonly depth?: number;
  readonly logPath?: string;
  readonly originalInput?: string;
  readonly now?: () => number;
}

export interface RunOptions {
  readonly signal?: AbortSignal;
  readonly listeners?: readonly EventListener[];
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function failed(code: string, message: string): TurnOutcome {
  return { type: "failed", code, message };
}

function firstUserInput(history: readonly Message[]): string | undefined {
  const message = history.find((entry): entry is UserMessage => entry.role === "user" && entry.synthetic === undefined);
  return message === undefined ? undefined : textOf(message);
}

export class AgentSession {
  readonly id: string;
  readonly spec: AgentSpec;
  readonly ledger: UsageLedger;
  readonly #options: AgentSessionOptions;
  readonly #toolSpecs: readonly ToolSpec[];
  readonly #runtime: ToolRuntime;
  readonly #loop = new LoopDetector();
  readonly #notes: SystemNote[] = [];
  readonly #now: () => number;
  #history: Message[];
  #listeners: readonly EventListener[] = [];
  #closed = false;
  #started = false;
  #startedAt: number | undefined;
  #turns = 0;
  #lastPromptTokens = 0;
  #lastCompactionTurn: number | undefined;
  #originalInput: string | undefined;

  constructor(options: AgentSessionOptions) {
    this.id = options.id;
    this.spec = options.spec;
    this.#options = options;
    this.#now = options.now ?? (() => Date.now());
    this.ledger = options.ledger ?? new UsageLedger(options.spec.name);
    this.#history = [...(options.history ?? [])];
    this.#originalInput = options.originalInput ?? firstUserInput(this.#history);
    const names = new Set<string>();
    for (const tool of options.tools) {
      if (names.has(tool.name)) {
        throw new AgentConfigError(`duplicate tool "${tool.name}"`);
      }
      names.add(tool.name);
    }
    const completionTool = options.spec.completion?.tool;
    if (completionTool !== undefined && !names.has(completionTool)) {
      throw new AgentConfigError(`completion tool "${completionTool}" is not among the session tools`);
    }
    this.#toolSpecs = [...options.tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map(toToolSpec);
    this.#runtime = new ToolRuntime({
      tools: options.tools,
      permissions: options.permissions,
      environment: options.environment,
      fileState: options.fileState ?? new InMemoryFileStateStore(),
      redactor: options.redactor,
      sessionId: options.id,
      agentName: options.spec.name,
      depth: options.depth ?? 0,
      ...(completionTool === undefined ? {} : { completionTool }),
      emit: async (body) => {
        await this.#emit(body);
      },
    });
  }

  get history(): readonly Message[] {
    return this.#history;
  }

  get pendingNotes(): readonly SystemNote[] {
    return this.#notes;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get tools(): readonly ToolSpec[] {
    return this.#toolSpecs;
  }

  async run(input: string, options: RunOptions = {}): Promise<TurnOutcome> {
    if (this.#closed) {
      throw new SessionClosedError(this.id);
    }
    this.#listeners = options.listeners ?? [];
    try {
      const outcome = await this.#run(input, options.signal ?? new AbortController().signal);
      if (TERMINAL_OUTCOMES.has(outcome.type)) {
        this.#closed = true;
      }
      await this.#emit({ type: "outcome", outcome });
      return outcome;
    } finally {
      this.#listeners = [];
    }
  }

  async #run(input: string, signal: AbortSignal): Promise<TurnOutcome> {
    const options = this.#options;
    this.#startedAt ??= this.#now();
    if (!this.#started) {
      this.#started = true;
      if (this.#history.length === 0) {
        await this.#emit({
          type: "session-start",
          sessionId: this.id,
          agentName: this.spec.name,
          provider: options.provider.id,
          model: this.spec.model.id,
          cwd: options.environment.root,
        });
      }
    }
    this.#originalInput ??= input;
    if (this.#history.length === 0 && options.projectContext !== undefined) {
      await this.#emit({ type: "context-loaded", sources: [...options.projectContext.sources] });
      await this.#append(options.projectContext.message);
    }
    await this.#append({ role: "user", parts: [...this.#pendingResults(), { type: "text", text: input }] });

    const completionTool = this.spec.completion?.tool;
    let streamRetries = 0;
    let pauses = 0;
    let reminders = 0;
    let maxOutputOverride: number | undefined;
    let compactedThisTurn = false;

    for (;;) {
      if (signal.aborted) {
        return { type: "aborted" };
      }
      const budget = checkBudget(this.spec.budget, this.ledger.snapshot(), this.#now() - this.#startedAt);
      if (!budget.ok) {
        return { type: "budget-exceeded", budget: budget.exceeded };
      }
      if (this.#shouldCompact()) {
        await this.#compactByThreshold(signal);
      }
      const tail = this.#endsWithUser() ? [...this.#notes] : [];
      const request = this.#request([...this.#history, ...tail], "auto", maxOutputOverride);

      let message: AssistantMessage;
      try {
        message = await this.#stream(request, signal, true);
      } catch (error) {
        if (isAborted(signal) || (error instanceof ProviderError && error.kind === "aborted")) {
          return { type: "aborted" };
        }
        if (!(error instanceof ProviderError)) {
          throw error;
        }
        if (error.kind === "stream-interrupted") {
          streamRetries += 1;
          if (streamRetries > MAX_STREAM_RETRIES) {
            return failed("provider-stream-interrupted", error.message);
          }
          continue;
        }
        if (error.kind === "context-exceeded") {
          if (compactedThisTurn || !(await this.#compactFromTranscript(signal))) {
            return failed("context-exceeded", error.message);
          }
          compactedThisTurn = true;
          continue;
        }
        return failed(`provider-${error.kind}`, error.message);
      }
      streamRetries = 0;
      await this.#recordUsage(message);
      const calls = toolCalls(message);

      if (message.stopReason === "refusal") {
        return message.stopDetails === undefined
          ? { type: "refused" }
          : { type: "refused", stopDetails: message.stopDetails };
      }
      if (message.stopReason === "context-exceeded") {
        if (compactedThisTurn || !(await this.#compactFromTranscript(signal))) {
          return failed("context-exceeded", "the conversation no longer fits the model context window");
        }
        compactedThisTurn = true;
        continue;
      }
      if (message.stopReason === "max-tokens" && calls.length > 0) {
        if (maxOutputOverride !== undefined) {
          return failed("tool-input-truncated", "tool call input was cut off by the output token limit twice");
        }
        maxOutputOverride = Math.min(2 * request.maxOutputTokens, this.#options.model.maxOutput);
        continue;
      }

      maxOutputOverride = undefined;
      compactedThisTurn = false;
      this.#turns += 1;
      await this.#commit(tail, message);

      if (message.stopReason === "pause") {
        pauses += 1;
        if (pauses > MAX_PAUSES) {
          return failed("pause-limit", `the provider paused more than ${String(MAX_PAUSES)} times in a row`);
        }
        continue;
      }
      pauses = 0;
      if (message.stopReason === "max-tokens") {
        return { type: "max-tokens" };
      }

      if (calls.length > 0) {
        const loop = this.#loop.observe(calls);
        if (loop.kind === "loop") {
          return { type: "loop-detected", tool: loop.tool };
        }
        if (loop.kind === "nudge") {
          this.#notes.push({
            role: "system",
            reason: "loop-nudge",
            text: `You have called \`${loop.tool}\` with identical input ${String(loop.count)} times in a row. The repeated call is not making progress; change your approach or finish the task.`,
          });
        }
        const batch = await this.#runtime.execute(calls, signal);
        if (batch.completion !== undefined) {
          return { type: "completed", text: textOf(message), result: batch.completion.result };
        }
        await this.#append({ role: "user", parts: batch.results });
        continue;
      }

      if (completionTool !== undefined) {
        if (reminders < MAX_COMPLETION_REMINDERS) {
          reminders += 1;
          await this.#append({
            role: "user",
            synthetic: "completion-reminder",
            parts: [
              {
                type: "text",
                text: `The task is not finished until you call the \`${completionTool}\` tool. Call it now, by itself, with your final result.`,
              },
            ],
          });
          continue;
        }
        return failed("completion-missing", `the agent ended without calling \`${completionTool}\``);
      }
      return { type: "completed", text: textOf(message) };
    }
  }

  #pendingResults(): ToolResultPart[] {
    const last = this.#history[this.#history.length - 1];
    if (last?.role !== "assistant") {
      return [];
    }
    const completionTool = this.spec.completion?.tool;
    return toolCalls(last).map((call) =>
      call.name === completionTool
        ? { type: "tool-result", toolCallId: call.id, content: "submitted", isError: false }
        : { type: "tool-result", toolCallId: call.id, content: "interrupted", isError: true },
    );
  }

  #endsWithUser(): boolean {
    return this.#history[this.#history.length - 1]?.role === "user";
  }

  #request(history: readonly Message[], toolChoice: ToolChoice, maxOutputTokens?: number): ProviderRequest {
    const effort = this.spec.model.effort;
    return {
      model: this.spec.model.id,
      system: this.#options.systemPrompt,
      tools: this.#toolSpecs,
      history,
      ...(effort === undefined ? {} : { effort }),
      maxOutputTokens: maxOutputTokens ?? this.#options.model.defaultMaxOutput,
      toolChoice,
      cacheKey: this.id,
    };
  }

  async #stream(request: ProviderRequest, signal: AbortSignal, forwardDeltas: boolean): Promise<AssistantMessage> {
    let message: AssistantMessage | undefined;
    for await (const event of this.#options.provider.stream(request, signal)) {
      if (event.type === "complete") {
        message = event.message;
      } else if (forwardDeltas) {
        for (const listener of this.#listeners) {
          listener.onDelta?.(event);
        }
      }
    }
    if (message === undefined) {
      throw new ProviderError("stream-interrupted", "the stream ended without a complete message");
    }
    return message;
  }

  async #recordUsage(message: AssistantMessage): Promise<void> {
    this.ledger.record(message.usage);
    this.#lastPromptTokens = message.usage.promptTokens;
    await this.#emit({ type: "usage", agentName: this.spec.name, usage: message.usage });
  }

  async #emit(body: EventBody): Promise<void> {
    const record = await this.#options.events.append(body);
    for (const listener of this.#listeners) {
      listener.onRecord?.(record);
    }
  }

  async #append(message: Message): Promise<void> {
    this.#history.push(message);
    await this.#emit({ type: "message", message });
  }

  async #commit(notes: readonly SystemNote[], message: AssistantMessage): Promise<void> {
    this.#notes.splice(0, notes.length);
    for (const note of notes) {
      await this.#append(note);
    }
    await this.#append(message);
  }

  #shouldCompact(): boolean {
    if (!this.#endsWithUser()) {
      return false;
    }
    if (this.#lastPromptTokens < COMPACTION_THRESHOLD * this.#options.model.contextWindow) {
      return false;
    }
    return this.#lastCompactionTurn === undefined || this.#turns - this.#lastCompactionTurn >= COMPACTION_INTERVAL_TURNS;
  }

  async #summarize(request: ProviderRequest, signal: AbortSignal): Promise<SummaryCheck> {
    try {
      const message = await this.#stream(request, signal, false);
      await this.#recordUsage(message);
      return checkSummary(message);
    } catch (error) {
      if (error instanceof ProviderError) {
        return { ok: false, reason: `${error.kind}: ${error.message}` };
      }
      throw error;
    }
  }

  async #compactByThreshold(signal: AbortSignal): Promise<void> {
    this.#lastCompactionTurn = this.#turns;
    const history = [...this.#history, compactionNote()];
    let reason = "";
    for (const toolChoice of ["auto", "none"] as const) {
      const summary = await this.#summarize(this.#request(history, toolChoice), signal);
      if (summary.ok) {
        await this.#replaceHistory("threshold", summary.text);
        return;
      }
      reason = summary.reason;
    }
    await this.#emit({ type: "error", code: "compaction-failed", message: reason });
  }

  async #compactFromTranscript(signal: AbortSignal): Promise<boolean> {
    this.#lastCompactionTurn = this.#turns;
    const budgetChars = Math.floor(this.#options.model.contextWindow * TRANSCRIPT_WINDOW_SHARE * CHARS_PER_TOKEN);
    const transcript = neutralTranscript(this.#history, budgetChars);
    const summary = await this.#summarize(this.#request([transcriptRequestMessage(transcript)], "none"), signal);
    if (!summary.ok) {
      await this.#emit({ type: "error", code: "compaction-failed", message: summary.reason });
      return false;
    }
    await this.#replaceHistory("context-exceeded", summary.text);
    return true;
  }

  async #replaceHistory(trigger: "threshold" | "context-exceeded", summary: string): Promise<void> {
    const options = this.#options;
    const next = compactedHistory({
      summary,
      ...(options.projectContext === undefined ? {} : { projectContext: options.projectContext.message }),
      ...(this.#originalInput === undefined ? {} : { originalInput: this.#originalInput }),
      ...(options.logPath === undefined ? {} : { logPath: options.logPath }),
    });
    await this.#emit({
      type: "compaction",
      trigger,
      replacedMessages: this.#history.length,
      summaryChars: summary.length,
    });
    this.#history = [];
    this.#loop.reset();
    for (const message of next) {
      await this.#append(message);
    }
  }
}

export function runSession(session: AgentSession, input: string, options: RunOptions = {}): Promise<TurnOutcome> {
  return session.run(input, options);
}
