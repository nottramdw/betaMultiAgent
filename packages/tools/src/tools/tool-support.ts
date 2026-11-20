import type { ToolResult } from "@betamultiagent/core";
import { errorMessage } from "../platform/errors.js";

export interface ErrorOutput {
  readonly error: string;
}

export function failure(error: unknown): ToolResult<ErrorOutput> {
  const message = errorMessage(error);
  return { output: { error: message }, promptText: message, isError: true };
}

export function success<O>(output: O, promptText: string): ToolResult<O> {
  return { output, promptText, isError: false };
}

export async function guarded<O>(
  run: () => Promise<ToolResult<O> | ToolResult<ErrorOutput>>,
): Promise<ToolResult<O | ErrorOutput>> {
  try {
    return await run();
  } catch (error) {
    return failure(error);
  }
}
