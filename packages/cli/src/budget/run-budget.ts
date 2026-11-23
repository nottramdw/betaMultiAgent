import type { EventBody, EventRecord, EventSink } from "@betamultiagent/core";
import type { CommandContext } from "../commands/command-context.js";
import { defaultLockEnvironment } from "../tasks/runner-lock.js";
import type { Workspace } from "../wiring.js";
import { DailySpend, spendDir, type SpendReservation } from "./daily-spend.js";

export interface RunBudget {
  readonly maxCostUsd?: number;
  readonly reservation?: SpendReservation;
}

export interface SpendLog extends EventSink {
  close?(): Promise<void>;
}

export function openDailySpend(context: CommandContext, workspace: Workspace): DailySpend | undefined {
  const limitUsd = workspace.config.budget.dailyMaxCostUsd;
  if (limitUsd === undefined) {
    return undefined;
  }
  return new DailySpend({
    dir: spendDir(workspace.dirs.state),
    limitUsd,
    now: context.io.now,
    lock: defaultLockEnvironment(context.io.now),
    warn: (message) => {
      context.err.line(`bma: ${message}`);
    },
  });
}

export async function reserveRunBudget(context: CommandContext, workspace: Workspace, capUsd: number | undefined): Promise<RunBudget> {
  const daily = openDailySpend(context, workspace);
  if (daily === undefined) {
    return capUsd === undefined ? {} : { maxCostUsd: capUsd };
  }
  const reservation = await daily.reserve(capUsd);
  return { maxCostUsd: reservation.amountUsd, reservation };
}

export function trackSpend(inner: SpendLog, reservation: SpendReservation | undefined): SpendLog {
  if (reservation === undefined) {
    return inner;
  }
  return {
    append: async (body: EventBody): Promise<EventRecord> => {
      const record = await inner.append(body);
      if (body.type === "usage") {
        reservation.record(body.usage.costUsd ?? 0);
      }
      return record;
    },
    close: async () => {
      await inner.close?.();
    },
  };
}
