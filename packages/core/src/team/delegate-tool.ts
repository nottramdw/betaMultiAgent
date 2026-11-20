import { z } from "zod";
import { defineTool, type ToolDefinition } from "../tools/tool-definition.js";

export const DELEGATE_TOOL = "delegate";
export const MAX_DELEGATE_TASKS = 4;

export const DelegateInputSchema = z.object({
  tasks: z
    .array(
      z.object({
        title: z.string().min(1).describe("Short name for the research task."),
        prompt: z.string().min(1).describe("Self-contained question; the researcher sees nothing else."),
      }),
    )
    .min(1)
    .max(MAX_DELEGATE_TASKS),
});
export type DelegateInput = z.infer<typeof DelegateInputSchema>;
export type DelegateTask = DelegateInput["tasks"][number];

export interface DelegateReport {
  readonly title: string;
  readonly status: "completed" | "failed";
  readonly summary: string;
}

export type DelegateRunner = (task: DelegateTask, signal: AbortSignal) => Promise<DelegateReport>;

function describeReports(reports: readonly DelegateReport[]): string {
  return reports
    .map((report, index) => `## ${String(index + 1)}. ${report.title} (${report.status})\n${report.summary}`)
    .join("\n\n");
}

export function createDelegateTool(run: DelegateRunner): ToolDefinition<DelegateInput, readonly DelegateReport[]> {
  return defineTool({
    name: DELEGATE_TOOL,
    description: `Run up to ${String(MAX_DELEGATE_TASKS)} read-only research tasks in parallel. Each task goes to a separate researcher that can read the workspace but cannot change it. Returns each researcher's summary.`,
    input: DelegateInputSchema,
    capabilities: { readOnly: true, maxConcurrency: 1 },
    permission: () => ({ kind: "none" }),
    execute: async (input, context) => {
      if (context.depth > 0) {
        return { output: [], promptText: "delegate is only available to the lead", isError: true };
      }
      const reports = await Promise.all(input.tasks.map((task) => run(task, context.signal)));
      return { output: reports, promptText: describeReports(reports), isError: false };
    },
  });
}
