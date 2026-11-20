import path from "node:path";
import { defineTool, type Environment, type ExecResult, type ToolDefinition } from "@betamultiagent/core";
import { z } from "zod";
import { MAX_EXEC_TIMEOUT_MS } from "../environment/local-environment.js";
import { guarded, type ErrorOutput } from "./tool-support.js";

const RunCommandInput = z.object({
  argv: z
    .array(z.string())
    .min(1)
    .max(64)
    .describe("Program and arguments as separate elements. No shell is used: pipes, redirection and globbing do not work."),
  cwd: z.string().min(1).optional().describe("Working directory inside the workspace. Defaults to the workspace root."),
  timeoutMs: z
    .number()
    .int()
    .min(1)
    .max(MAX_EXEC_TIMEOUT_MS)
    .optional()
    .describe("Timeout in milliseconds. Defaults to 120000, at most 600000."),
});

export function formatExecResult(result: ExecResult): string {
  const header = [
    `exit code: ${result.exitCode === null ? "none" : String(result.exitCode)}`,
    `signal: ${result.signal ?? "none"}`,
    `timed out: ${result.timedOut ? "yes" : "no"}`,
    `output truncated: ${result.truncated ? "yes" : "no"}`,
    `duration: ${String(result.durationMs)} ms`,
  ];
  const sections = [header.join("\n")];
  if (result.stdout.length > 0) {
    sections.push(`--- stdout ---\n${result.stdout}`);
  }
  if (result.stderr.length > 0) {
    sections.push(`--- stderr ---\n${result.stderr}`);
  }
  return sections.join("\n");
}

export function createRunCommandTool(
  environment: Environment,
): ToolDefinition<z.infer<typeof RunCommandInput>, ExecResult | ErrorOutput> {
  return defineTool({
    name: "run_command",
    description:
      "Run a program with an explicit argument list, without a shell. Output is truncated and the process tree is killed on timeout. Runs alone, never in parallel with other tools.",
    input: RunCommandInput,
    capabilities: { readOnly: false, exclusive: true },
    permission: (input) => ({
      kind: "exec",
      argv: input.argv,
      cwd: path.resolve(environment.root, input.cwd ?? "."),
    }),
    execute: (input, context) =>
      guarded(async () => {
        const result = await context.environment.exec(input.argv, {
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
          signal: context.signal,
        });
        return {
          output: result,
          promptText: formatExecResult(result),
          isError: result.timedOut || result.exitCode !== 0,
        };
      }),
  });
}
