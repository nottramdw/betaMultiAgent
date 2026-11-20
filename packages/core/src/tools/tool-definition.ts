import type { z } from "zod";
import type { Environment, FileStateStore } from "../environment/environment.js";
import type { PermissionRequest } from "../permissions/permission-types.js";
import { toToolSpec } from "./tool-spec.js";

export interface ToolCapabilities {
  readonly readOnly: boolean;
  readonly maxConcurrency?: number;
  readonly exclusive?: boolean;
}

export interface ToolResult<O = unknown> {
  readonly output: O;
  readonly promptText: string;
  readonly isError: boolean;
}

export interface ToolContext {
  readonly environment: Environment;
  readonly signal: AbortSignal;
  readonly sessionId: string;
  readonly agentName: string;
  readonly fileState: FileStateStore;
  readonly depth: number;
  isPathDenied(path: string, mode: "read" | "write"): Promise<boolean>;
}

export interface ToolDefinition<I = unknown, O = unknown> {
  readonly name: string;
  readonly description: string;
  readonly input: z.ZodType<I>;
  readonly capabilities: ToolCapabilities;
  permission(input: I): PermissionRequest;
  execute(input: I, context: ToolContext): Promise<ToolResult<O>>;
}

export function defineTool<I, O>(definition: ToolDefinition<I, O>): ToolDefinition<I, O> {
  toToolSpec(definition);
  return definition;
}
