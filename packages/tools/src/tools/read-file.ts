import { defineTool, type ToolDefinition } from "@betamultiagent/core";
import { z } from "zod";
import { looksBinary, loadFile, recordFileState } from "../files/file-io.js";
import { guarded, success, type ErrorOutput } from "./tool-support.js";

export const DEFAULT_READ_LIMIT = 2000;

const ReadFileInput = z.object({
  path: z.string().min(1).describe("Path of the file, relative to the workspace root or absolute inside it."),
  offset: z.number().int().min(1).optional().describe("1-based line number to start from. Defaults to 1."),
  limit: z.number().int().min(1).optional().describe("Maximum number of lines to return. Defaults to 2000."),
});

export interface ReadFileOutput {
  readonly path: string;
  readonly totalLines: number;
  readonly startLine: number;
  readonly endLine: number;
}

function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\n/u);
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

export function createReadFileTool(): ToolDefinition<z.infer<typeof ReadFileInput>, ReadFileOutput | ErrorOutput> {
  return defineTool({
    name: "read_file",
    description:
      "Read a text file with numbered lines. Files must be read before they can be modified. Binary files and files over 10 MiB are rejected.",
    input: ReadFileInput,
    capabilities: { readOnly: true },
    permission: (input) => ({ kind: "read", paths: [input.path] }),
    execute: (input, context) =>
      guarded(async () => {
        const resolved = await context.environment.resolvePath(input.path, "read");
        const { bytes, stat } = await loadFile(resolved.real);
        if (looksBinary(bytes)) {
          throw new Error(`${input.path} looks like a binary file and cannot be read as text`);
        }
        recordFileState(context.fileState, resolved.real, stat, bytes);
        const text = bytes.toString("utf8").replace(/^\uFEFF/u, "");
        const lines = splitLines(text);
        const totalLines = text.length === 0 ? 0 : lines.length;
        const startLine = input.offset ?? 1;
        const limit = input.limit ?? DEFAULT_READ_LIMIT;
        const selected = lines.slice(startLine - 1, startLine - 1 + limit);
        const endLine = selected.length === 0 ? startLine - 1 : startLine - 1 + selected.length;
        const numbered = selected.map((line, index) => `${String(startLine + index).padStart(6)}\t${line}`);
        let promptText = numbered.join("\n");
        if (totalLines === 0) {
          promptText = "(empty file)";
        } else if (selected.length === 0) {
          promptText = `(no lines at offset ${String(startLine)}; the file has ${String(totalLines)} lines)`;
        } else if (endLine < totalLines) {
          promptText += `\n[showing lines ${String(startLine)}-${String(endLine)} of ${String(totalLines)}; use offset=${String(endLine + 1)} to continue]`;
        }
        return success({ path: input.path, totalLines, startLine, endLine }, promptText);
      }),
  });
}
