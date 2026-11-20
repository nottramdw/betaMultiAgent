import type { Environment, FileStateStore } from "../environment/environment.js";
import type { EventBody } from "../events/events.js";
import type { ToolCallPart, ToolResultPart } from "../messages/messages.js";
import type { PermissionOutcome, PermissionRequest } from "../permissions/permission-types.js";
import type { Redactor } from "../redaction/redaction.js";
import { finalizePromptText } from "../tools/prompt-text.js";
import type { ToolContext, ToolDefinition } from "../tools/tool-definition.js";
import { ExclusiveGate, Semaphore, type Release } from "./concurrency.js";
import { PathLocks } from "./path-locks.js";

export interface PermissionGate {
  authorize(request: PermissionRequest): Promise<PermissionOutcome>;
  isPathDenied(target: string, mode: "read" | "write"): Promise<boolean>;
}

export interface ToolRuntimeOptions {
  readonly tools: readonly ToolDefinition[];
  readonly permissions: PermissionGate;
  readonly environment: Environment;
  readonly fileState: FileStateStore;
  readonly redactor: Redactor;
  readonly sessionId: string;
  readonly agentName: string;
  readonly depth: number;
  readonly completionTool?: string;
  readonly emit: (body: EventBody) => Promise<void>;
  readonly now?: () => number;
}

export interface ToolBatchOutcome {
  readonly results: ToolResultPart[];
  readonly completion?: { readonly result: unknown };
}

type Prepared =
  | { readonly kind: "done"; readonly part: ToolResultPart }
  | {
      readonly kind: "run";
      readonly call: ToolCallPart;
      readonly tool: ToolDefinition;
      readonly input: unknown;
      readonly request: PermissionRequest;
    };

interface Executed {
  readonly part: ToolResultPart;
  readonly output: unknown;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ToolRuntime {
  readonly #tools: ReadonlyMap<string, ToolDefinition>;
  readonly #options: ToolRuntimeOptions;
  readonly #gate = new ExclusiveGate();
  readonly #locks: PathLocks;
  readonly #limits = new Map<string, Semaphore>();
  readonly #now: () => number;

  constructor(options: ToolRuntimeOptions) {
    this.#options = options;
    this.#tools = new Map(options.tools.map((tool) => [tool.name, tool]));
    this.#locks = new PathLocks(options.environment.caseSensitive);
    this.#now = options.now ?? (() => performance.now());
  }

  get completionTool(): string | undefined {
    return this.#options.completionTool;
  }

  async execute(calls: readonly ToolCallPart[], signal: AbortSignal): Promise<ToolBatchOutcome> {
    const prepared: Prepared[] = [];
    for (const call of calls) {
      prepared.push(await this.#prepare(call, calls.length));
    }
    const executed = await Promise.all(
      prepared.map((item) =>
        item.kind === "done" ? Promise.resolve<Executed>({ part: item.part, output: undefined }) : this.#run(item, signal),
      ),
    );
    const results = executed.map((item) => item.part);
    const only = calls.length === 1 ? calls[0] : undefined;
    const completed = only !== undefined && only.name === this.completionTool ? executed[0] : undefined;
    if (completed !== undefined && !completed.part.isError) {
      return { results, completion: { result: this.#options.redactor.redactValue(completed.output) } };
    }
    return { results };
  }

  #result(call: ToolCallPart, content: string, isError: boolean): ToolResultPart {
    return {
      type: "tool-result",
      toolCallId: call.id,
      content: finalizePromptText(content, this.#options.redactor),
      isError,
    };
  }

  #invalid(call: ToolCallPart, detail: string): Prepared {
    return { kind: "done", part: this.#result(call, JSON.stringify({ INVALID_INPUT: detail }), true) };
  }

  async #prepare(call: ToolCallPart, batchSize: number): Promise<Prepared> {
    const tool = this.#tools.get(call.name);
    if (tool === undefined) {
      return this.#invalid(call, `unknown tool "${call.name}"`);
    }
    if (call.inputError !== undefined) {
      return this.#invalid(call, "tool input is not valid JSON");
    }
    const parsed = tool.input.safeParse(call.input);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.length === 0 ? "(root)" : issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      return this.#invalid(call, detail);
    }
    if (call.name === this.completionTool && batchSize > 1) {
      return {
        kind: "done",
        part: this.#result(call, `\`${call.name}\` must be called alone in a turn. Call it again by itself.`, true),
      };
    }
    let request: PermissionRequest;
    try {
      request = tool.permission(parsed.data);
    } catch (error) {
      return { kind: "done", part: this.#result(call, `Tool failed: ${errorMessage(error)}`, true) };
    }
    if (request.kind !== "none") {
      const outcome = await this.#options.permissions.authorize(request);
      await this.#options.emit({
        type: "permission",
        request,
        allowed: outcome.allowed,
        source: outcome.verdict.source,
        reason: outcome.verdict.reason,
        sensitive: outcome.verdict.sensitive,
        ...(outcome.approval === undefined ? {} : { approval: outcome.approval }),
      });
      if (!outcome.allowed) {
        return {
          kind: "done",
          part: this.#result(call, `Permission denied by policy: ${outcome.verdict.reason}`, true),
        };
      }
    }
    return { kind: "run", call, tool, input: parsed.data, request };
  }

  #limit(tool: ToolDefinition): Semaphore | undefined {
    const max = tool.capabilities.maxConcurrency;
    if (max === undefined) {
      return undefined;
    }
    let semaphore = this.#limits.get(tool.name);
    if (semaphore === undefined) {
      semaphore = new Semaphore(max);
      this.#limits.set(tool.name, semaphore);
    }
    return semaphore;
  }

  async #lockKeys(item: Extract<Prepared, { kind: "run" }>): Promise<string[]> {
    if (item.tool.capabilities.readOnly || item.request.kind !== "write") {
      return [];
    }
    const resolved = await Promise.all(
      item.request.paths.map((target) => this.#options.environment.resolvePath(target, "write")),
    );
    return resolved.map((entry) => entry.real);
  }

  async #run(item: Extract<Prepared, { kind: "run" }>, signal: AbortSignal): Promise<Executed> {
    const releases: Release[] = [];
    try {
      releases.push(await this.#gate.acquire(item.tool.capabilities.exclusive === true));
      const semaphore = this.#limit(item.tool);
      if (semaphore !== undefined) {
        releases.push(await semaphore.acquire());
      }
      releases.push(await this.#locks.acquire(await this.#lockKeys(item)));
      return await this.#invoke(item, signal);
    } catch (error) {
      return { part: this.#result(item.call, `Tool failed: ${errorMessage(error)}`, true), output: undefined };
    } finally {
      for (const release of releases.reverse()) {
        release();
      }
    }
  }

  async #invoke(item: Extract<Prepared, { kind: "run" }>, signal: AbortSignal): Promise<Executed> {
    const options = this.#options;
    const context: ToolContext = {
      environment: options.environment,
      signal,
      sessionId: options.sessionId,
      agentName: options.agentName,
      fileState: options.fileState,
      depth: options.depth,
      isPathDenied: (target, mode) => options.permissions.isPathDenied(target, mode),
    };
    await options.emit({ type: "tool-start", toolCallId: item.call.id, name: item.call.name, input: item.input });
    const started = this.#now();
    let executed: Executed;
    try {
      const result = await item.tool.execute(item.input, context);
      executed = { part: this.#result(item.call, result.promptText, result.isError), output: result.output };
    } catch (error) {
      executed = { part: this.#result(item.call, `Tool failed: ${errorMessage(error)}`, true), output: undefined };
    }
    await options.emit({
      type: "tool-end",
      toolCallId: item.call.id,
      name: item.call.name,
      isError: executed.part.isError,
      durationMs: Math.max(0, this.#now() - started),
      promptText: executed.part.content,
    });
    return executed;
  }
}
