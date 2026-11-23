import { AgentRoleSchema, CostSourceSchema, type Redactor } from "@betamultiagent/core";
import { appendFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const AUDIT_VERSION = 1;
const MONTH_FILE = /^(\d{4})-(\d{2})\.jsonl$/u;
const DAY_MS = 24 * 60 * 60 * 1000;

const UsageTotalsRecordSchema = z.object({
  turns: z.number().int().nonnegative(),
  promptTokens: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  costSource: CostSourceSchema,
});

const ApprovalSourceSchema = z.enum(["tty", "yes-verify", "rule", "untrusted-skip", "not-approved"]);
export type ApprovalSource = z.infer<typeof ApprovalSourceSchema>;

const AuditedCommandSchema = z.object({ argv: z.array(z.string()), source: ApprovalSourceSchema });
export type AuditedCommand = z.infer<typeof AuditedCommandSchema>;

const RoleModelSchema = z.object({ model: z.string().min(1), effort: z.string().min(1) });

const RunStartSchema = z.object({
  kind: z.literal("run-start"),
  command: z.enum(["run", "team"]),
  roles: z.partialRecord(AgentRoleSchema, RoleModelSchema),
  budget: z.object({ maxCostUsd: z.number().positive().optional(), maxWallMs: z.number().int().positive().optional() }),
  taskSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  taskPrefix: z.string(),
  taskId: z.string().min(1).optional(),
});

const PermissionSchema = z.object({
  kind: z.literal("permission"),
  role: AgentRoleSchema,
  sessionId: z.string().min(1),
  action: z.enum(["read", "write", "exec"]),
  target: z.array(z.string()),
  allowed: z.boolean(),
  source: z.string().min(1),
  approval: z.string().min(1).optional(),
});

const RunOutcomeSchema = z.object({
  kind: z.literal("run-outcome"),
  status: z.string().min(1),
  code: z.string().min(1).optional(),
  revisions: z.number().int().nonnegative().optional(),
  planCorrections: z.number().int().nonnegative().optional(),
  invalidInputs: z.number().int().nonnegative(),
  usage: UsageTotalsRecordSchema,
  usageByRole: z.partialRecord(AgentRoleSchema, UsageTotalsRecordSchema),
  verification: z.string().min(1).optional(),
  approvedCommands: z.array(AuditedCommandSchema),
  unapprovedCommands: z.array(AuditedCommandSchema),
  commit: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
});

const AuditBodySchema = z.discriminatedUnion("kind", [RunStartSchema, PermissionSchema, RunOutcomeSchema]);
export type AuditBody = z.infer<typeof AuditBodySchema>;

export const AuditRecordSchema = z.intersection(
  z.object({ v: z.literal(AUDIT_VERSION), ts: z.iso.datetime(), runId: z.string().min(1) }),
  AuditBodySchema,
);
export type AuditRecord = z.infer<typeof AuditRecordSchema>;

export type AuditWarn = (message: string) => void;

export interface OpenAuditLedgerOptions {
  readonly dir: string;
  readonly runId: string;
  readonly redactor: Redactor;
  readonly retentionDays: number;
  readonly now: () => Date;
  readonly warn: AuditWarn;
}

function monthKey(date: Date): string {
  return `${String(date.getUTCFullYear())}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function pruneAuditLedger(dir: string, retentionDays: number, now: Date): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const cutoff = now.getTime() - retentionDays * DAY_MS;
  const removed: string[] = [];
  for (const name of names) {
    const match = MONTH_FILE.exec(name);
    if (match === null) {
      continue;
    }
    const monthEnd = Date.UTC(Number(match[1]), Number(match[2]), 1);
    if (monthEnd <= cutoff) {
      await rm(path.join(dir, name), { force: true });
      removed.push(name);
    }
  }
  return removed.sort();
}

export class AuditLedger {
  readonly dir: string;
  readonly runId: string;
  readonly #redactor: Redactor;
  readonly #now: () => Date;
  readonly #warn: AuditWarn;
  #tail: Promise<void> = Promise.resolve();
  #failed = false;

  private constructor(options: OpenAuditLedgerOptions) {
    this.dir = options.dir;
    this.runId = options.runId;
    this.#redactor = options.redactor;
    this.#now = options.now;
    this.#warn = options.warn;
  }

  static async open(options: OpenAuditLedgerOptions): Promise<AuditLedger> {
    const ledger = new AuditLedger(options);
    try {
      await mkdir(options.dir, { recursive: true, mode: 0o700 });
      await pruneAuditLedger(options.dir, options.retentionDays, options.now());
    } catch (error) {
      ledger.#fail(error);
    }
    return ledger;
  }

  record(body: AuditBody): void {
    if (this.#failed) {
      return;
    }
    const now = this.#now();
    let line: string;
    try {
      const record = AuditRecordSchema.parse(
        this.#redactor.redactValue({ v: AUDIT_VERSION, ts: now.toISOString(), runId: this.runId, ...body }),
      );
      line = `${JSON.stringify(record)}\n`;
    } catch (error) {
      this.#fail(error);
      return;
    }
    const file = path.join(this.dir, `${monthKey(now)}.jsonl`);
    this.#tail = this.#tail.then(async () => {
      if (this.#failed) {
        return;
      }
      try {
        await appendFile(file, line, { encoding: "utf8", mode: 0o600 });
      } catch (error) {
        this.#fail(error);
      }
    });
  }

  async close(): Promise<void> {
    await this.#tail;
  }

  #fail(error: unknown): void {
    if (!this.#failed) {
      this.#failed = true;
      this.#warn(`audit ledger disabled for this run: ${errorMessage(error)}`);
    }
  }
}

export async function readAuditLedger(dir: string, warn: AuditWarn): Promise<AuditRecord[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const records: AuditRecord[] = [];
  for (const name of names.filter((entry) => MONTH_FILE.test(entry)).sort()) {
    const lines = (await readFile(path.join(dir, name), "utf8")).split("\n");
    for (const [index, line] of lines.entries()) {
      if (line.trim().length === 0) {
        continue;
      }
      let parsed: ReturnType<typeof AuditRecordSchema.safeParse>;
      try {
        parsed = AuditRecordSchema.safeParse(JSON.parse(line));
      } catch {
        warn(`${name}:${String(index + 1)}: skipped unparsable audit record`);
        continue;
      }
      if (parsed.success) {
        records.push(parsed.data);
      } else {
        warn(`${name}:${String(index + 1)}: skipped invalid audit record`);
      }
    }
  }
  return records;
}
