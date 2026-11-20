import { defineTool, type ToolDefinition } from "@betamultiagent/core";
import { z } from "zod";
import { assertUnchangedSinceRead, loadFile, looksBinary } from "../files/file-io.js";
import { guarded, success, type ErrorOutput } from "./tool-support.js";
import { commitWrite } from "./write-support.js";

const EditFileInput = z.object({
  path: z.string().min(1).describe("Path of the file, relative to the workspace root or absolute inside it."),
  old_string: z.string().min(1).describe("Exact text to replace. Must be unique in the file unless replace_all is true."),
  new_string: z.string().describe("Replacement text."),
  replace_all: z.boolean().optional().describe("Replace every occurrence instead of requiring a unique match."),
});

export interface EditFileOutput {
  readonly path: string;
  readonly replacements: number;
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let index = text.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}

function toCrlf(text: string): string {
  return text.replace(/\r?\n/gu, "\r\n");
}

export function createEditFileTool(): ToolDefinition<z.infer<typeof EditFileInput>, EditFileOutput | ErrorOutput> {
  return defineTool({
    name: "edit_file",
    description:
      "Replace exact text in an existing file. The file must have been read with read_file in this session and must not have changed since. old_string must match exactly once unless replace_all is true. CRLF files and the UTF-8 BOM are preserved.",
    input: EditFileInput,
    capabilities: { readOnly: false },
    permission: (input) => ({ kind: "write", paths: [input.path] }),
    execute: (input, context) =>
      guarded(async () => {
        if (input.old_string === input.new_string) {
          throw new Error("old_string and new_string are identical");
        }
        const resolved = await context.environment.resolvePath(input.path, "write");
        const { bytes, stat } = await loadFile(resolved.real);
        await assertUnchangedSinceRead(context.fileState, resolved.real, input.path, stat, bytes);
        if (looksBinary(bytes)) {
          throw new Error(`${input.path} looks like a binary file and cannot be edited`);
        }
        const decoded = bytes.toString("utf8");
        if (!Buffer.from(decoded, "utf8").equals(bytes)) {
          throw new Error(`${input.path} is not valid UTF-8 and cannot be edited`);
        }
        const hasBom = decoded.startsWith("\uFEFF");
        const body = hasBom ? decoded.slice(1) : decoded;
        const crlf = body.includes("\r\n");
        const oldText = crlf ? toCrlf(input.old_string) : input.old_string;
        const newText = crlf ? toCrlf(input.new_string) : input.new_string;
        const occurrences = countOccurrences(body, oldText);
        if (occurrences === 0) {
          throw new Error(`old_string was not found in ${input.path}`);
        }
        const replaceAll = input.replace_all === true;
        if (occurrences > 1 && !replaceAll) {
          throw new Error(
            `old_string matches ${String(occurrences)} places in ${input.path}; add surrounding context to make it unique or set replace_all`,
          );
        }
        const updated = replaceAll ? body.split(oldText).join(newText) : body.replace(oldText, () => newText);
        const data = Buffer.from(hasBom ? `\uFEFF${updated}` : updated, "utf8");
        await commitWrite(context, input.path, resolved, data, stat.mode);
        const replacements = replaceAll ? occurrences : 1;
        return success({ path: input.path, replacements }, `Edited ${input.path} (${String(replacements)} replacement${replacements === 1 ? "" : "s"})`);
      }),
  });
}
