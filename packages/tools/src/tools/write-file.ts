import { promises as fsp, type Stats } from "node:fs";
import { defineTool, type ToolDefinition } from "@betamultiagent/core";
import { z } from "zod";
import { MAX_READ_BYTES, assertUnchangedSinceRead } from "../files/file-io.js";
import { isMissingError } from "../platform/errors.js";
import { guarded, success, type ErrorOutput } from "./tool-support.js";
import { commitWrite } from "./write-support.js";

const WriteFileInput = z.object({
  path: z.string().min(1).describe("Path of the file, relative to the workspace root or absolute inside it."),
  content: z.string().describe("Full new content of the file."),
});

export interface WriteFileOutput {
  readonly path: string;
  readonly bytes: number;
  readonly created: boolean;
}

export function createWriteFileTool(): ToolDefinition<z.infer<typeof WriteFileInput>, WriteFileOutput | ErrorOutput> {
  return defineTool({
    name: "write_file",
    description:
      "Create a file or replace its whole content. An existing file must have been read with read_file in this session and must not have changed since. Parent directories are created.",
    input: WriteFileInput,
    capabilities: { readOnly: false },
    permission: (input) => ({ kind: "write", paths: [input.path] }),
    execute: (input, context) =>
      guarded(async () => {
        const data = Buffer.from(input.content, "utf8");
        if (data.length > MAX_READ_BYTES) {
          throw new Error(`content is ${String(data.length)} bytes; the limit is ${String(MAX_READ_BYTES)} bytes`);
        }
        const resolved = await context.environment.resolvePath(input.path, "write");
        let existing: Stats | undefined;
        try {
          existing = await fsp.stat(resolved.real);
        } catch (error) {
          if (!isMissingError(error)) {
            throw error;
          }
        }
        if (existing !== undefined) {
          if (!existing.isFile()) {
            throw new Error(`${input.path} is not a regular file`);
          }
          await assertUnchangedSinceRead(context.fileState, resolved.real, input.path, existing);
        }
        await commitWrite(context, input.path, resolved, data, existing?.mode);
        const created = existing === undefined;
        return success(
          { path: input.path, bytes: data.length, created },
          `${created ? "Created" : "Updated"} ${input.path} (${String(data.length)} bytes)`,
        );
      }),
  });
}
