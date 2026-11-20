import { promises as fsp } from "node:fs";
import { defineTool, type ToolDefinition } from "@betamultiagent/core";
import picomatch from "picomatch";
import { z } from "zod";
import { guarded, success, type ErrorOutput } from "./tool-support.js";
import { toDisplayPath, walkFiles } from "./walk.js";

export const MAX_GLOB_RESULTS = 1000;

const GlobInput = z.object({
  pattern: z.string().min(1).describe("Glob pattern matched against paths relative to the search directory, for example **/*.ts."),
  path: z.string().min(1).optional().describe("Directory to search. Defaults to the workspace root."),
});

export interface GlobOutput {
  readonly paths: readonly string[];
  readonly truncated: boolean;
}

export function createGlobTool(): ToolDefinition<z.infer<typeof GlobInput>, GlobOutput | ErrorOutput> {
  return defineTool({
    name: "glob",
    description:
      "Find files by glob pattern. Results are sorted, relative to the workspace root, limited to 1000 entries. .git and node_modules are skipped.",
    input: GlobInput,
    capabilities: { readOnly: true },
    permission: (input) => ({ kind: "read", paths: [input.path ?? "."] }),
    execute: (input, context) =>
      guarded(async () => {
        const { environment } = context;
        const base = await environment.resolvePath(input.path ?? ".", "read");
        const stat = await fsp.stat(base.real);
        if (!stat.isDirectory()) {
          throw new Error(`${input.path ?? "."} is not a directory`);
        }
        const matcher = picomatch(input.pattern, { dot: true, nocase: !environment.caseSensitive });
        const paths: string[] = [];
        await walkFiles(
          { root: environment.root, start: base.real, caseSensitive: environment.caseSensitive, signal: context.signal },
          async (file) => {
            if (!matcher(file.relative) || (await context.isPathDenied(file.absolute, "read"))) {
              return true;
            }
            paths.push(toDisplayPath(environment.root, file.absolute));
            return paths.length <= MAX_GLOB_RESULTS;
          },
        );
        const truncated = paths.length > MAX_GLOB_RESULTS;
        const results = truncated ? paths.slice(0, MAX_GLOB_RESULTS) : paths;
        const promptText =
          results.length === 0
            ? "No files matched."
            : `${results.join("\n")}${truncated ? `\n[results limited to ${String(MAX_GLOB_RESULTS)} entries]` : ""}`;
        return success({ paths: results, truncated }, promptText);
      }),
  });
}
