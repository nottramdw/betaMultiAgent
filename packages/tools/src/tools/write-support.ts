import { promises as fsp } from "node:fs";
import { PathEscapeError, type ResolvedPath, type ToolContext } from "@betamultiagent/core";
import { atomicWrite, recordFileState } from "../files/file-io.js";
import { samePath } from "../platform/containment.js";

export async function commitWrite(
  context: ToolContext,
  requested: string,
  resolved: ResolvedPath,
  data: Buffer,
  mode: number | undefined,
): Promise<void> {
  await atomicWrite({
    real: resolved.real,
    data,
    ...(mode === undefined ? {} : { mode }),
    beforeRename: async () => {
      const again = await context.environment.resolvePath(requested, "write");
      if (!samePath(again.real, resolved.real, context.environment.caseSensitive)) {
        throw new PathEscapeError(requested, "the resolved location changed while writing");
      }
    },
  });
  const stat = await fsp.stat(resolved.real);
  recordFileState(context.fileState, resolved.real, stat, data);
}
