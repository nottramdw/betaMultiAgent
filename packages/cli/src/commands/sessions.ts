import { isStale, readLock, readSessionEvents, ULID_PATTERN, ulidTime, type EventRecord } from "@betamultiagent/core";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { EXIT_FAILED, EXIT_OK, errorMessage, usageError } from "../cli-error.js";
import { sessionsDir } from "../config/paths.js";
import { JsonlWriter } from "../output/jsonl.js";
import { displayValue } from "../output/sanitize.js";
import { openWorkspace } from "../wiring.js";
import type { CommandContext } from "./command-context.js";

const DEFAULT_PRUNE_DAYS = 30;

interface SessionSummary {
  readonly id: string;
  readonly createdAt: string;
  readonly agent?: string;
  readonly model?: string;
  readonly outcome?: string;
  readonly costUsd: number;
  readonly locked: boolean;
  readonly error?: string;
}

async function listIds(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => ULID_PATTERN.test(name)).sort();
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function isLocked(dir: string): Promise<boolean> {
  const lock = await readLock(dir);
  return lock !== undefined && !isStale(lock);
}

function summarize(id: string, records: readonly EventRecord[], locked: boolean): SessionSummary {
  let agent: string | undefined;
  let model: string | undefined;
  let outcome: string | undefined;
  let costUsd = 0;
  for (const record of records) {
    if (record.type === "session-start") {
      agent = record.agentName;
      model = `${record.provider}:${record.model}`;
    } else if (record.type === "outcome") {
      outcome = record.outcome.type;
    } else if (record.type === "usage") {
      costUsd += record.usage.costUsd ?? 0;
    }
  }
  return {
    id,
    createdAt: new Date(ulidTime(id)).toISOString(),
    ...(agent === undefined ? {} : { agent }),
    ...(model === undefined ? {} : { model }),
    ...(outcome === undefined ? {} : { outcome }),
    costUsd,
    locked,
  };
}

function checkId(id: string | undefined): string {
  if (id === undefined || !ULID_PATTERN.test(id)) {
    throw usageError(`invalid session id ${JSON.stringify(id ?? "")}`);
  }
  return id;
}

function recordLine(record: EventRecord): string {
  switch (record.type) {
    case "message":
      return `${record.message.role}: ${displayValue("parts" in record.message ? record.message.parts : record.message.text, 300)}`;
    case "tool-start":
      return `tool ${record.name} ${displayValue(record.input, 200)}`;
    case "tool-end":
      return `tool ${record.name} ${record.isError ? "error" : "ok"}: ${displayValue(record.promptText, 200)}`;
    case "outcome":
      return `outcome ${displayValue(record.outcome, 300)}`;
    default:
      return `${record.type} ${displayValue(record, 200)}`;
  }
}

export async function sessionsCommand(context: CommandContext, args: readonly string[]): Promise<number> {
  const [action, ...rest] = args;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    strict: true,
    options: { json: { type: "boolean", default: false }, "older-than": { type: "string" } },
  });
  const workspace = await openWorkspace(context.io, context.redactor);
  const dir = sessionsDir(workspace.dirs, workspace.root);
  const json = new JsonlWriter(context.io.stdout, context.redactor);
  switch (action) {
    case undefined:
    case "list": {
      const summaries: SessionSummary[] = [];
      for (const id of await listIds(dir)) {
        const sessionDir = path.join(dir, id);
        const locked = await isLocked(sessionDir);
        try {
          summaries.push(summarize(id, await readSessionEvents(sessionDir), locked));
        } catch (error) {
          summaries.push({ id, createdAt: new Date(ulidTime(id)).toISOString(), costUsd: 0, locked, error: errorMessage(error) });
        }
      }
      if (values.json) {
        json.writeResult("sessions", { sessions: summaries });
        return EXIT_OK;
      }
      if (summaries.length === 0) {
        context.err.line("bma: no sessions for this workspace");
      }
      for (const entry of summaries) {
        const parts = [entry.id, entry.createdAt, entry.agent ?? "?", entry.model ?? "?", entry.outcome ?? (entry.locked ? "running" : "unfinished")];
        context.out.line(`${parts.join("  ")}  $${entry.costUsd.toFixed(4)}${entry.error === undefined ? "" : `  (${entry.error})`}`);
      }
      return EXIT_OK;
    }
    case "show": {
      const id = checkId(positionals[0]);
      const records = await readSessionEvents(path.join(dir, id));
      for (const record of records) {
        if (values.json) {
          json.write(record);
        } else {
          context.out.line(`${String(record.seq)} ${record.ts} ${recordLine(record)}`);
        }
      }
      return EXIT_OK;
    }
    case "rm": {
      const id = checkId(positionals[0]);
      const sessionDir = path.join(dir, id);
      if (!(await listIds(dir)).includes(id)) {
        throw usageError(`no session ${id} in this workspace`);
      }
      if (await isLocked(sessionDir)) {
        context.err.line(`bma: session ${id} is in use by a running process`);
        return EXIT_FAILED;
      }
      await rm(sessionDir, { recursive: true, force: true });
      context.err.line(`bma: removed session ${id}`);
      return EXIT_OK;
    }
    case "prune": {
      const days = values["older-than"] === undefined ? DEFAULT_PRUNE_DAYS : Number(values["older-than"]);
      if (!Number.isFinite(days) || days < 0) {
        throw usageError(`--older-than must be a non-negative number of days, got ${JSON.stringify(values["older-than"])}`);
      }
      const cutoff = context.io.now().getTime() - days * 86_400_000;
      let removed = 0;
      let skipped = 0;
      for (const id of await listIds(dir)) {
        if (ulidTime(id) >= cutoff) {
          continue;
        }
        const sessionDir = path.join(dir, id);
        if (await isLocked(sessionDir)) {
          skipped += 1;
          continue;
        }
        await rm(sessionDir, { recursive: true, force: true });
        removed += 1;
      }
      context.err.line(`bma: removed ${String(removed)} session(s)${skipped === 0 ? "" : `, skipped ${String(skipped)} in use`}`);
      return EXIT_OK;
    }
    default:
      throw usageError(`unknown sessions action ${JSON.stringify(action)}; expected list, show, rm or prune`);
  }
}
