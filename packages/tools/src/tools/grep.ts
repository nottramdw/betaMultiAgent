import { promises as fsp } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { defineTool, type ToolDefinition } from "@betamultiagent/core";
import picomatch from "picomatch";
import { z } from "zod";
import { BINARY_PROBE_BYTES } from "../files/file-io.js";
import { isAborted } from "../platform/errors.js";
import { GREP_WORKER_SOURCE } from "./grep-worker-source.js";
import { failure, guarded, success, type ErrorOutput } from "./tool-support.js";
import { toDisplayPath, walkFiles, type WalkedFile } from "./walk.js";

export const GREP_TIMEOUT_MS = 10_000;
export const MAX_GREP_RESULTS = 500;
export const DEFAULT_GREP_RESULTS = 200;
export const MAX_GREP_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_GREP_LINE_CHARS = 500;
export const MAX_GREP_FILES = 20_000;
const DENY_CHECK_BATCH = 16;

const GrepInput = z.object({
  pattern: z.string().min(1).describe("JavaScript regular expression matched against each line."),
  path: z.string().min(1).optional().describe("File or directory to search. Defaults to the workspace root."),
  glob: z.string().min(1).optional().describe("Only search files whose path relative to the search directory matches this glob."),
  ignoreCase: z.boolean().optional().describe("Match case-insensitively."),
  maxResults: z.number().int().min(1).optional().describe("Maximum matches to return. Defaults to 200, capped at 500."),
});

const WorkerResultSchema = z.object({
  matches: z.array(z.object({ file: z.string(), line: z.number(), text: z.string() })),
  skippedBinary: z.number(),
  skippedLarge: z.number(),
  truncated: z.boolean(),
});

type WorkerResult = z.infer<typeof WorkerResultSchema>;
type WorkerOutcome = { readonly kind: "done"; readonly result: WorkerResult } | { readonly kind: "timeout" } | { readonly kind: "aborted" };

export interface GrepMatch {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

export interface GrepOutput {
  readonly matches: readonly GrepMatch[];
  readonly filesSearched: number;
  readonly skippedDenied: number;
  readonly skippedBinary: number;
  readonly skippedLarge: number;
  readonly truncated: boolean;
}

export interface GrepToolOptions {
  readonly timeoutMs?: number;
}

interface WorkerFile {
  readonly absolute: string;
  readonly display: string;
}

function runWorker(
  request: {
    readonly pattern: string;
    readonly flags: string;
    readonly files: readonly WorkerFile[];
    readonly maxResults: number;
  },
  timeoutMs: number,
  signal: AbortSignal,
): Promise<WorkerOutcome> {
  return new Promise<WorkerOutcome>((resolve, reject) => {
    const worker = new Worker(GREP_WORKER_SOURCE, {
      eval: true,
      workerData: {
        ...request,
        maxLineChars: MAX_GREP_LINE_CHARS,
        maxFileBytes: MAX_GREP_FILE_BYTES,
        probeBytes: BINARY_PROBE_BYTES,
      },
    });
    let settled = false;
    const settle = (action: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      worker.terminate().catch(() => undefined);
      action();
    };
    const timer = setTimeout(() => {
      settle(() => {
        resolve({ kind: "timeout" });
      });
    }, timeoutMs);
    function onAbort(): void {
      settle(() => {
        resolve({ kind: "aborted" });
      });
    }
    signal.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (message: unknown) => {
      settle(() => {
        const parsed = WorkerResultSchema.safeParse(message);
        if (parsed.success) {
          resolve({ kind: "done", result: parsed.data });
        } else {
          reject(new Error("grep worker returned an unexpected message"));
        }
      });
    });
    worker.once("error", (error) => {
      settle(() => {
        reject(error);
      });
    });
    worker.once("exit", (code) => {
      settle(() => {
        reject(new Error(`grep worker exited unexpectedly with code ${String(code)}`));
      });
    });
  });
}

async function filterDenied(
  files: readonly WalkedFile[],
  isDenied: (absolute: string) => Promise<boolean>,
): Promise<{ readonly allowed: WalkedFile[]; readonly denied: number }> {
  const allowed: WalkedFile[] = [];
  let denied = 0;
  for (let index = 0; index < files.length; index += DENY_CHECK_BATCH) {
    const batch = files.slice(index, index + DENY_CHECK_BATCH);
    const verdicts = await Promise.all(batch.map((file) => isDenied(file.absolute)));
    batch.forEach((file, position) => {
      if (verdicts[position] === true) {
        denied += 1;
      } else {
        allowed.push(file);
      }
    });
  }
  return { allowed, denied };
}

export function createGrepTool(options: GrepToolOptions = {}): ToolDefinition<z.infer<typeof GrepInput>, GrepOutput | ErrorOutput> {
  const timeoutMs = options.timeoutMs ?? GREP_TIMEOUT_MS;
  return defineTool({
    name: "grep",
    description:
      "Search file contents with a JavaScript regular expression. Skips binary files, files over 2 MiB, .git and node_modules. Returns at most 500 matches with lines cut to 500 characters. Stops after 10 seconds.",
    input: GrepInput,
    capabilities: { readOnly: true },
    permission: (input) => ({ kind: "read", paths: [input.path ?? "."] }),
    execute: (input, context) =>
      guarded(async () => {
        const { environment } = context;
        const flags = input.ignoreCase === true ? "i" : "";
        try {
          new RegExp(input.pattern, flags);
        } catch (error) {
          throw new Error(`invalid regular expression: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
        const base = await environment.resolvePath(input.path ?? ".", "read");
        const stat = await fsp.stat(base.real);
        const globMatcher =
          input.glob === undefined ? undefined : picomatch(input.glob, { dot: true, nocase: !environment.caseSensitive });
        const candidates: WalkedFile[] = [];
        let capped = false;
        if (stat.isFile()) {
          candidates.push({ absolute: base.real, relative: path.basename(base.real) });
        } else {
          const summary = await walkFiles(
            { root: environment.root, start: base.real, caseSensitive: environment.caseSensitive, signal: context.signal },
            (file) => {
              if (globMatcher === undefined || globMatcher(file.relative)) {
                candidates.push(file);
              }
              return Promise.resolve(candidates.length < MAX_GREP_FILES);
            },
          );
          capped = summary.limitReached || candidates.length >= MAX_GREP_FILES;
        }
        const { allowed, denied } = await filterDenied(candidates, (absolute) => context.isPathDenied(absolute, "read"));
        const maxResults = Math.min(input.maxResults ?? DEFAULT_GREP_RESULTS, MAX_GREP_RESULTS);
        const outcome = await runWorker(
          {
            pattern: input.pattern,
            flags,
            files: allowed.map((file) => ({ absolute: file.absolute, display: toDisplayPath(environment.root, file.absolute) })),
            maxResults,
          },
          timeoutMs,
          context.signal,
        );
        if (outcome.kind === "timeout") {
          return failure(
            `grep stopped after ${String(Math.round(timeoutMs / 1000))} s; the pattern may cause catastrophic backtracking. Use a simpler pattern or a narrower path.`,
          );
        }
        if (outcome.kind === "aborted" || isAborted(context.signal)) {
          return failure("grep was cancelled");
        }
        const { result } = outcome;
        const output: GrepOutput = {
          matches: result.matches,
          filesSearched: allowed.length,
          skippedDenied: denied,
          skippedBinary: result.skippedBinary,
          skippedLarge: result.skippedLarge,
          truncated: result.truncated || capped,
        };
        const lines = result.matches.map((match) => `${match.file}:${String(match.line)}: ${match.text}`);
        const summary = [
          `${String(result.matches.length)} match(es) in ${String(allowed.length)} file(s) searched`,
          `skipped: ${String(denied)} denied, ${String(result.skippedBinary)} binary, ${String(result.skippedLarge)} over 2 MiB`,
        ];
        if (output.truncated) {
          summary.push("results or file list were truncated");
        }
        return success(output, [...lines, `[${summary.join("; ")}]`].join("\n"));
      }),
  });
}
