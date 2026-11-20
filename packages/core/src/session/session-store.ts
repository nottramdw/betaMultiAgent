import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, truncate, unlink, type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { EventBodySchema, EventRecordSchema, type EventBody, type EventRecord, type EventType } from "../events/events.js";
import { PROTOCOL_VERSION } from "../events/protocol-version.js";
import type { Message } from "../messages/messages.js";
import type { Redactor } from "../redaction/redaction.js";

export const EVENTS_FILE = "events.jsonl";
export const LOCK_FILE = "session.lock";

const DURABLE_TYPES: ReadonlySet<EventType> = new Set(["session-start", "message", "outcome"]);

export const SessionLockSchema = z.object({
  pid: z.number().int(),
  hostname: z.string(),
  startedAt: z.string(),
  token: z.string(),
});
export type SessionLock = z.infer<typeof SessionLockSchema>;

export class SessionLockedError extends Error {
  readonly lock: SessionLock | undefined;

  constructor(dir: string, lock: SessionLock | undefined) {
    super(
      lock === undefined
        ? `session ${dir} is locked`
        : `session ${dir} is locked by pid ${String(lock.pid)} on ${lock.hostname} since ${lock.startedAt}`,
    );
    this.name = "SessionLockedError";
    this.lock = lock;
  }
}

export class SessionCorruptError extends Error {
  readonly line: number;

  constructor(file: string, line: number, detail: string) {
    super(`${file}:${String(line)} is corrupt: ${detail}`);
    this.name = "SessionCorruptError";
    this.line = line;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

export interface StaleCheck {
  readonly hostname?: string;
  readonly isAlive?: (pid: number) => boolean;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, "EPERM");
  }
}

export function isStale(lock: SessionLock, check: StaleCheck = {}): boolean {
  const hostname = check.hostname ?? os.hostname();
  if (lock.hostname !== hostname) {
    return false;
  }
  return !(check.isAlive ?? processAlive)(lock.pid);
}

export async function readLock(dir: string): Promise<SessionLock | undefined> {
  try {
    const parsed = SessionLockSchema.safeParse(JSON.parse(await readFile(path.join(dir, LOCK_FILE), "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch (error) {
    if (isErrno(error, "ENOENT") || error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

interface ParsedLog {
  readonly records: EventRecord[];
  readonly validBytes: number;
  readonly totalBytes: number;
}

function parseRecord(line: string): EventRecord | undefined {
  try {
    const parsed = EventRecordSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function parseLog(file: string, buffer: Buffer): ParsedLog {
  const text = buffer.toString("utf8");
  const segments = text.split("\n");
  const complete = segments.slice(0, -1);
  const records: EventRecord[] = [];
  let validBytes = 0;
  for (const [index, line] of complete.entries()) {
    const record = parseRecord(line);
    const previous = records[records.length - 1];
    const ordered = record !== undefined && (previous === undefined || record.seq > previous.seq);
    if (!ordered) {
      if (index === complete.length - 1) {
        break;
      }
      throw new SessionCorruptError(file, index + 1, record === undefined ? "unparsable record" : "sequence out of order");
    }
    records.push(record);
    validBytes += Buffer.byteLength(line, "utf8") + 1;
  }
  return { records, validBytes, totalBytes: buffer.length };
}

async function readLog(file: string): Promise<ParsedLog> {
  try {
    return parseLog(file, await readFile(file));
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return { records: [], validBytes: 0, totalBytes: 0 };
    }
    throw error;
  }
}

export async function readSessionEvents(dir: string): Promise<EventRecord[]> {
  return (await readLog(path.join(dir, EVENTS_FILE))).records;
}

export function replayMessages(records: readonly EventRecord[]): Message[] {
  const messages: Message[] = [];
  for (const record of records) {
    if (record.type === "compaction") {
      messages.length = 0;
    } else if (record.type === "message") {
      messages.push(record.message);
    }
  }
  return messages;
}

export interface OpenSessionOptions {
  readonly dir: string;
  readonly redactor: Redactor;
  readonly now?: () => Date;
  readonly hostname?: string;
  readonly pid?: number;
}

export class SessionStore {
  readonly dir: string;
  readonly #handle: FileHandle;
  readonly #redactor: Redactor;
  readonly #now: () => Date;
  readonly #token: string;
  readonly #records: EventRecord[];
  #seq: number;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;

  private constructor(
    dir: string,
    handle: FileHandle,
    records: EventRecord[],
    token: string,
    options: OpenSessionOptions,
  ) {
    this.dir = dir;
    this.#handle = handle;
    this.#records = records;
    this.#token = token;
    this.#redactor = options.redactor;
    this.#now = options.now ?? (() => new Date());
    this.#seq = records[records.length - 1]?.seq ?? 0;
  }

  static async open(options: OpenSessionOptions): Promise<SessionStore> {
    const dir = options.dir;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const token = randomBytes(16).toString("hex");
    const lock: SessionLock = {
      pid: options.pid ?? process.pid,
      hostname: options.hostname ?? os.hostname(),
      startedAt: (options.now ?? (() => new Date()))().toISOString(),
      token,
    };
    const lockPath = path.join(dir, LOCK_FILE);
    let lockHandle: FileHandle;
    try {
      lockHandle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (isErrno(error, "EEXIST")) {
        throw new SessionLockedError(dir, await readLock(dir));
      }
      throw error;
    }
    try {
      await lockHandle.writeFile(`${JSON.stringify(lock)}\n`, "utf8");
    } finally {
      await lockHandle.close();
    }

    try {
      const file = path.join(dir, EVENTS_FILE);
      const log = await readLog(file);
      if (log.validBytes < log.totalBytes) {
        await truncate(file, log.validBytes);
      }
      const handle = await open(file, "a", 0o600);
      return new SessionStore(dir, handle, log.records, token, options);
    } catch (error) {
      await unlink(lockPath).catch(() => undefined);
      throw error;
    }
  }

  get lastSeq(): number {
    return this.#seq;
  }

  records(): readonly EventRecord[] {
    return this.#records;
  }

  messages(): Message[] {
    return replayMessages(this.#records);
  }

  append(body: EventBody): Promise<EventRecord> {
    if (this.#closed) {
      return Promise.reject(new Error(`session ${this.dir} is closed`));
    }
    const validated = EventBodySchema.parse(body);
    this.#seq += 1;
    const record = this.#redactor.redactValue<EventRecord>({
      v: PROTOCOL_VERSION,
      seq: this.#seq,
      ts: this.#now().toISOString(),
      ...validated,
    });
    this.#records.push(record);
    const line = `${JSON.stringify(record)}\n`;
    const durable = DURABLE_TYPES.has(record.type);
    const write = this.#tail.then(async () => {
      await this.#handle.write(line);
      if (durable) {
        await this.#handle.sync();
      }
    });
    this.#tail = write.catch(() => undefined);
    return write.then(() => record);
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await this.#tail;
    await this.#handle.close();
    const lock = await readLock(this.dir);
    if (lock?.token === this.#token) {
      await unlink(path.join(this.dir, LOCK_FILE));
    }
  }
}
