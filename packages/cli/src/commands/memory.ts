import { parseArgs } from "node:util";
import { EXIT_OK, usageError } from "../cli-error.js";
import { findMemory, MemoryLookupError, MemoryStatusSchema, type MemoryEntry, type MemoryStatus, type MemoryStore } from "../memory/memory-store.js";
import { JsonlWriter } from "../output/jsonl.js";
import { displayValue } from "../output/sanitize.js";
import { openMemoryStore, openWorkspace } from "../wiring.js";
import type { CommandContext } from "./command-context.js";

type MemoryAction = "approve" | "reject" | "rm";

const ALLOWED_FROM: Readonly<Record<MemoryAction, ReadonlySet<MemoryStatus>>> = {
  approve: new Set(["pending"]),
  reject: new Set(["pending"]),
  rm: new Set(["pending", "approved"]),
};

const PAST: Readonly<Record<MemoryAction, string>> = { approve: "approved", reject: "rejected", rm: "removed" };

const LISTED_BY_DEFAULT: ReadonlySet<MemoryStatus> = new Set(["pending", "approved"]);

async function openStore(context: CommandContext): Promise<MemoryStore> {
  const workspace = await openWorkspace(context.io, context.redactor);
  return openMemoryStore(workspace, (message) => {
    context.err.line(`bma: memory: ${message}`);
  });
}

function actor(context: CommandContext): string {
  const name = context.io.env["USER"] ?? context.io.env["USERNAME"];
  return name === undefined || name.trim().length === 0 ? "user" : name.trim();
}

async function listMemory(context: CommandContext, args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: { status: { type: "string" }, json: { type: "boolean", default: false } },
  });
  if (positionals.length > 0) {
    throw usageError("bma memory list takes no positional arguments");
  }
  const status = values.status === undefined ? undefined : MemoryStatusSchema.safeParse(values.status);
  if (status !== undefined && !status.success) {
    throw usageError(`--status must be one of ${MemoryStatusSchema.options.join(", ")}`);
  }
  const entries = (await (await openStore(context)).load()).filter((entry) =>
    status === undefined ? LISTED_BY_DEFAULT.has(entry.status) : entry.status === status.data,
  );
  if (values.json) {
    new JsonlWriter(context.io.stdout, context.redactor).writeResult("memory-list", { entries });
    return EXIT_OK;
  }
  if (entries.length === 0) {
    context.out.line("no memory entries");
    return EXIT_OK;
  }
  for (const entry of entries) {
    context.out.line(`${entry.id}  ${entry.status.padEnd(8)}  ${displayValue(entry.text, 500)}`);
    const decided = entry.decidedBy === undefined ? "" : `; ${entry.status} by ${displayValue(entry.decidedBy)} on ${(entry.decidedAt ?? "").slice(0, 10)}`;
    context.out.line(`  proposed by ${displayValue(entry.source.agent)} in session ${displayValue(entry.source.sessionId)} on ${entry.proposedAt.slice(0, 10)}${decided}`);
    if (entry.reason !== undefined) {
      context.out.line(`  reason: ${displayValue(entry.reason, 500)}`);
    }
  }
  return EXIT_OK;
}

function resolve(entries: readonly MemoryEntry[], reference: string): MemoryEntry {
  try {
    return findMemory(entries, reference);
  } catch (error) {
    if (error instanceof MemoryLookupError) {
      throw usageError(error.message);
    }
    throw error;
  }
}

async function changeMemory(context: CommandContext, action: MemoryAction, args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: { json: { type: "boolean", default: false } },
  });
  if (positionals.length === 0) {
    throw usageError(`usage: bma memory ${action} <id>...`);
  }
  const store = await openStore(context);
  const entries = await store.load();
  const targets = [...new Map(positionals.map((reference) => resolve(entries, reference)).map((entry) => [entry.id, entry])).values()];
  for (const entry of targets) {
    if (!ALLOWED_FROM[action].has(entry.status)) {
      throw usageError(`memory entry ${entry.id} is ${entry.status} and cannot be ${PAST[action]}`);
    }
  }
  const by = actor(context);
  for (const entry of targets) {
    if (action === "rm") {
      await store.remove(entry.id, by);
    } else {
      await store.decide(entry.id, action === "approve" ? "approved" : "rejected", by);
    }
  }
  if (values.json) {
    new JsonlWriter(context.io.stdout, context.redactor).writeResult("memory-updated", { status: PAST[action], ids: targets.map((entry) => entry.id) });
    return EXIT_OK;
  }
  for (const entry of targets) {
    context.out.line(`memory entry ${entry.id} ${PAST[action]}`);
  }
  return EXIT_OK;
}

export async function memoryCommand(context: CommandContext, args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub?.startsWith("-") === true) {
    return listMemory(context, args);
  }
  switch (sub) {
    case "list":
    case undefined:
      return listMemory(context, rest);
    case "approve":
    case "reject":
    case "rm":
      return changeMemory(context, sub, rest);
    default:
      throw usageError(`unknown memory command ${JSON.stringify(sub)}; expected list, approve, reject or rm`);
  }
}
