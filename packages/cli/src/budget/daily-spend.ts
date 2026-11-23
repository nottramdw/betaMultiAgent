import { ulid } from "@betamultiagent/core";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { CliError, EXIT_BUDGET, EXIT_FAILED } from "../cli-error.js";
import { acquireRunnerLock, RunnerLockError, type LockEnvironment } from "../tasks/runner-lock.js";

export const SPEND_LOCK_FILE = "spend.lock";
export const LOCK_WAIT_MS = 10_000;
const LOCK_RETRY_MS = 20;

const EntrySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("reserve"),
    id: z.string().min(1),
    pid: z.number().int().positive(),
    hostname: z.string(),
    amountUsd: z.number().nonnegative(),
    at: z.string(),
  }),
  z.object({ type: z.literal("spend"), id: z.string().min(1), costUsd: z.number().nonnegative(), at: z.string() }),
  z.object({ type: z.literal("release"), id: z.string().min(1), at: z.string() }),
]);
type Entry = z.infer<typeof EntrySchema>;

export interface SpendSummary {
  readonly day: string;
  readonly limitUsd: number;
  readonly spentUsd: number;
  readonly reservedUsd: number;
  readonly remainingUsd: number;
}

export interface DailySpendOptions {
  readonly dir: string;
  readonly limitUsd: number;
  readonly now: () => Date;
  readonly lock: LockEnvironment;
  readonly warn: (message: string) => void;
  readonly lockWaitMs?: number;
}

export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function spendDir(state: string): string {
  return path.join(state, "spend");
}

function usd(value: number): string {
  return `$${value.toFixed(4)}`;
}

export function parseLedger(text: string, file: string): Entry[] {
  const entries: Entry[] = [];
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    if (line.trim().length === 0) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = undefined;
    }
    const entry = EntrySchema.safeParse(parsed);
    if (!entry.success) {
      throw new CliError(EXIT_FAILED, `daily spend ledger ${file} has an unreadable line ${String(index + 1)}; runs are refused while the daily cost cap cannot be checked`);
    }
    entries.push(entry.data);
  });
  return entries;
}

export function totals(entries: readonly Entry[], lock: Pick<LockEnvironment, "hostname" | "isAlive">): { spentUsd: number; reservedUsd: number } {
  const spentById = new Map<string, number>();
  const released = new Set<string>();
  let spentUsd = 0;
  for (const entry of entries) {
    if (entry.type === "spend") {
      spentUsd += entry.costUsd;
      spentById.set(entry.id, (spentById.get(entry.id) ?? 0) + entry.costUsd);
    } else if (entry.type === "release") {
      released.add(entry.id);
    }
  }
  let reservedUsd = 0;
  for (const entry of entries) {
    if (entry.type !== "reserve" || released.has(entry.id)) {
      continue;
    }
    if (entry.hostname === lock.hostname && !lock.isAlive(entry.pid)) {
      continue;
    }
    reservedUsd += Math.max(0, entry.amountUsd - (spentById.get(entry.id) ?? 0));
  }
  return { spentUsd, reservedUsd };
}

export class SpendReservation {
  readonly id: string;
  readonly amountUsd: number;
  readonly #ledger: DailySpend;
  readonly #file: string;
  #chain: Promise<void> = Promise.resolve();
  #released = false;

  constructor(ledger: DailySpend, file: string, id: string, amountUsd: number) {
    this.#ledger = ledger;
    this.#file = file;
    this.id = id;
    this.amountUsd = amountUsd;
  }

  record(costUsd: number): void {
    if (!(costUsd > 0) || this.#released) {
      return;
    }
    this.#chain = this.#chain.then(() => this.#ledger.append(this.#file, { type: "spend", id: this.id, costUsd }));
  }

  async flush(): Promise<void> {
    await this.#chain;
  }

  async release(): Promise<void> {
    if (this.#released) {
      return;
    }
    this.#released = true;
    await this.#chain;
    await this.#ledger.append(this.#file, { type: "release", id: this.id });
  }
}

type NewEntry = { readonly type: "spend"; readonly id: string; readonly costUsd: number } | { readonly type: "release"; readonly id: string } | { readonly type: "reserve"; readonly id: string; readonly amountUsd: number };

export class DailySpend {
  readonly #options: DailySpendOptions;

  constructor(options: DailySpendOptions) {
    this.#options = options;
  }

  get limitUsd(): number {
    return this.#options.limitUsd;
  }

  #file(day: string): string {
    return path.join(this.#options.dir, `${day}.jsonl`);
  }

  async #read(file: string): Promise<Entry[]> {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw new CliError(EXIT_FAILED, `daily spend ledger ${file} cannot be read; runs are refused while the daily cost cap cannot be checked`);
    }
    return parseLedger(text, file);
  }

  #line(entry: NewEntry): string {
    const at = this.#options.now().toISOString();
    const full = entry.type === "reserve" ? { ...entry, pid: this.#options.lock.pid, hostname: this.#options.lock.hostname, at } : { ...entry, at };
    return `${JSON.stringify(full)}\n`;
  }

  async #withLock<T>(work: () => Promise<T>): Promise<T> {
    await mkdir(this.#options.dir, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + (this.#options.lockWaitMs ?? LOCK_WAIT_MS);
    for (;;) {
      try {
        const lock = await acquireRunnerLock(this.#options.dir, this.#options.lock, { file: SPEND_LOCK_FILE, holder: "spend ledger writer" });
        try {
          return await work();
        } finally {
          await lock.release();
        }
      } catch (error) {
        if (!(error instanceof RunnerLockError)) {
          throw error;
        }
        if (Date.now() >= deadline) {
          throw new CliError(EXIT_FAILED, `the daily spend ledger lock ${path.join(this.#options.dir, SPEND_LOCK_FILE)} stays held; ${error.message}`);
        }
        await sleep(LOCK_RETRY_MS);
      }
    }
  }

  async append(file: string, entry: NewEntry): Promise<void> {
    try {
      await this.#withLock(() => appendFile(file, this.#line(entry), { encoding: "utf8", mode: 0o600 }));
    } catch (error) {
      this.#options.warn(`daily spend ledger: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  #summary(day: string, entries: readonly Entry[]): SpendSummary {
    const { spentUsd, reservedUsd } = totals(entries, this.#options.lock);
    const limitUsd = this.#options.limitUsd;
    return { day, limitUsd, spentUsd, reservedUsd, remainingUsd: Math.max(0, limitUsd - spentUsd - reservedUsd) };
  }

  async summary(): Promise<SpendSummary> {
    const day = utcDay(this.#options.now());
    return this.#withLock(async () => this.#summary(day, await this.#read(this.#file(day))));
  }

  async hasRemaining(): Promise<boolean> {
    return (await this.summary()).remainingUsd > 0;
  }

  async reserve(capUsd: number | undefined): Promise<SpendReservation> {
    const day = utcDay(this.#options.now());
    const file = this.#file(day);
    return this.#withLock(async () => {
      const summary = this.#summary(day, await this.#read(file));
      if (summary.remainingUsd <= 0) {
        throw new CliError(EXIT_BUDGET, `the daily cost cap of ${usd(summary.limitUsd)} for ${day} (UTC) is reached: spent ${usd(summary.spentUsd)}, reserved by active runs ${usd(summary.reservedUsd)}`);
      }
      const amountUsd = capUsd === undefined ? summary.remainingUsd : Math.min(capUsd, summary.remainingUsd);
      const id = ulid(this.#options.now().getTime());
      await appendFile(file, this.#line({ type: "reserve", id, amountUsd }), { encoding: "utf8", mode: 0o600 });
      return new SpendReservation(this, file, id, amountUsd);
    });
  }

  async charge(costUsd: number): Promise<void> {
    if (!(costUsd > 0)) {
      return;
    }
    const day = utcDay(this.#options.now());
    await this.append(this.#file(day), { type: "spend", id: `charge-${ulid(this.#options.now().getTime())}`, costUsd });
  }
}
