import { ulid, type Redactor } from "@betamultiagent/core";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const MEMORY_EVENT_VERSION = 1;
export const MEMORY_FILE = "memory.jsonl";
export const MAX_MEMORY_TEXT = 500;
export const MAX_PENDING_MEMORY = 50;
export const MAX_PROPOSALS_PER_SESSION = 5;
export const MEMORY_CONTEXT_LIMIT_BYTES = 8 * 1024;
export const MIN_MEMORY_ID_PREFIX = 4;

export const MemoryStatusSchema = z.enum(["pending", "approved", "rejected", "removed"]);
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>;

const SourceSchema = z.object({ agent: z.string().min(1), sessionId: z.string().min(1) });
export type MemorySource = z.infer<typeof SourceSchema>;

const EventSchema = z.intersection(
  z.object({ v: z.literal(MEMORY_EVENT_VERSION), ts: z.iso.datetime() }),
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("proposed"), id: z.string().min(1), text: z.string().min(1).max(MAX_MEMORY_TEXT), reason: z.string().max(MAX_MEMORY_TEXT).optional(), source: SourceSchema }),
    z.object({ type: z.literal("decided"), id: z.string().min(1), decision: z.enum(["approved", "rejected"]), by: z.string().min(1) }),
    z.object({ type: z.literal("removed"), id: z.string().min(1), by: z.string().min(1) }),
  ]),
);
type MemoryEvent = z.infer<typeof EventSchema>;

export interface MemoryEntry {
  readonly id: string;
  readonly text: string;
  readonly reason?: string;
  readonly source: MemorySource;
  readonly proposedAt: string;
  readonly status: MemoryStatus;
  readonly decidedBy?: string;
  readonly decidedAt?: string;
}

export class MemoryLimitError extends Error {}

export class MemoryLookupError extends Error {}

export type MemoryWarn = (message: string) => void;

function fold(events: readonly MemoryEvent[], warn: MemoryWarn): MemoryEntry[] {
  const entries = new Map<string, MemoryEntry>();
  for (const event of events) {
    if (event.type === "proposed") {
      if (entries.has(event.id)) {
        warn(`duplicate memory entry ${event.id} ignored`);
        continue;
      }
      entries.set(event.id, {
        id: event.id,
        text: event.text,
        ...(event.reason === undefined ? {} : { reason: event.reason }),
        source: event.source,
        proposedAt: event.ts,
        status: "pending",
      });
      continue;
    }
    const current = entries.get(event.id);
    if (current === undefined) {
      warn(`event for unknown memory entry ${event.id} ignored`);
      continue;
    }
    const status: MemoryStatus = event.type === "removed" ? "removed" : event.decision;
    entries.set(event.id, { ...current, status, decidedBy: event.by, decidedAt: event.ts });
  }
  return [...entries.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export interface MemoryProposal {
  readonly text: string;
  readonly reason?: string;
  readonly source: MemorySource;
}

export class MemoryStore {
  readonly dir: string;
  readonly #redactor: Redactor;
  readonly #now: () => Date;
  readonly #warn: MemoryWarn;

  constructor(dir: string, redactor: Redactor, now: () => Date, warn: MemoryWarn) {
    this.dir = dir;
    this.#redactor = redactor;
    this.#now = now;
    this.#warn = warn;
  }

  get file(): string {
    return path.join(this.dir, MEMORY_FILE);
  }

  async load(): Promise<MemoryEntry[]> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const events: MemoryEvent[] = [];
    for (const [index, line] of text.split("\n").entries()) {
      if (line.trim().length === 0) {
        continue;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        raw = undefined;
      }
      const parsed = EventSchema.safeParse(raw);
      if (parsed.success) {
        events.push(parsed.data);
      } else {
        this.#warn(`${MEMORY_FILE}:${String(index + 1)}: skipped invalid memory event`);
      }
    }
    return fold(events, this.#warn);
  }

  async propose(proposal: MemoryProposal): Promise<MemoryEntry> {
    const entries = await this.load();
    if (entries.filter((entry) => entry.status === "pending").length >= MAX_PENDING_MEMORY) {
      throw new MemoryLimitError(`${String(MAX_PENDING_MEMORY)} memory proposals already wait for review`);
    }
    if (entries.filter((entry) => entry.source.sessionId === proposal.source.sessionId).length >= MAX_PROPOSALS_PER_SESSION) {
      throw new MemoryLimitError(`a session may propose at most ${String(MAX_PROPOSALS_PER_SESSION)} memory entries`);
    }
    const id = ulid(this.#now().getTime());
    await this.#append({ type: "proposed", id, text: proposal.text, ...(proposal.reason === undefined ? {} : { reason: proposal.reason }), source: proposal.source });
    const stored = (await this.load()).find((entry) => entry.id === id);
    if (stored === undefined) {
      throw new Error(`memory entry ${id} was not stored`);
    }
    return stored;
  }

  async decide(id: string, decision: "approved" | "rejected", by: string): Promise<void> {
    await this.#append({ type: "decided", id, decision, by });
  }

  async remove(id: string, by: string): Promise<void> {
    await this.#append({ type: "removed", id, by });
  }

  async #append(body: Record<string, unknown>): Promise<void> {
    const event = EventSchema.parse(this.#redactor.redactValue({ v: MEMORY_EVENT_VERSION, ts: this.#now().toISOString(), ...body }));
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await appendFile(this.file, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  }
}

export function findMemory(entries: readonly MemoryEntry[], reference: string): MemoryEntry {
  const needle = reference.toUpperCase();
  const exact = entries.find((entry) => entry.id === needle);
  if (exact !== undefined) {
    return exact;
  }
  if (needle.length < MIN_MEMORY_ID_PREFIX) {
    throw new MemoryLookupError(`memory id ${JSON.stringify(reference)} is too short; give at least ${String(MIN_MEMORY_ID_PREFIX)} characters`);
  }
  const matches = entries.filter((entry) => entry.id.startsWith(needle));
  if (matches.length === 1 && matches[0] !== undefined) {
    return matches[0];
  }
  throw new MemoryLookupError(matches.length === 0 ? `no memory entry matches ${JSON.stringify(reference)}` : `memory id ${JSON.stringify(reference)} is ambiguous`);
}

export function renderMemory(entries: readonly MemoryEntry[]): string | undefined {
  const approved = entries.filter((entry) => entry.status === "approved").reverse();
  const lines: string[] = [];
  let bytes = 0;
  for (const entry of approved) {
    const line = `- ${entry.text.replace(/\s+/gu, " ").replace(/</gu, "&lt;").trim()} (${entry.id}, approved ${(entry.decidedAt ?? entry.proposedAt).slice(0, 10)})`;
    const size = Buffer.byteLength(line, "utf8") + 1;
    if (bytes + size > MEMORY_CONTEXT_LIMIT_BYTES) {
      break;
    }
    lines.push(line);
    bytes += size;
  }
  if (lines.length === 0) {
    return undefined;
  }
  const omitted = approved.length - lines.length;
  return [
    "Facts the user approved for this workspace, newest first:",
    ...lines,
    ...(omitted > 0 ? [`(${String(omitted)} older entries omitted for size)`] : []),
  ].join("\n");
}
