import type {
  AgentRole,
  CommandApprover,
  EventBody,
  EventRecord,
  EventSink,
  ModelRef,
  PermissionRequest,
  TeamCommand,
  TeamOutcome,
  TeamSessionLog,
  TurnOutcome,
  UsageTotals,
} from "@betamultiagent/core";
import { createHash } from "node:crypto";
import path from "node:path";
import type { ApprovalSource, AuditedCommand, AuditLedger } from "./audit-ledger.js";

export const TASK_PREFIX_CHARS = 80;
export const MAX_ARGV_TOKENS = 16;
export const MAX_TOKEN_CHARS = 120;
const INVALID_INPUT_PREFIX = '{"INVALID_INPUT"';

export interface RunStartInput {
  readonly command: "run" | "team";
  readonly roles: Partial<Record<AgentRole, ModelRef>>;
  readonly budget: { readonly maxCostUsd?: number; readonly maxWallMs?: number };
  readonly task: string;
  readonly taskId?: string;
}

function truncateToken(token: string): string {
  return token.length > MAX_TOKEN_CHARS ? `${token.slice(0, MAX_TOKEN_CHARS)}…` : token;
}

export function auditArgv(argv: readonly string[]): string[] {
  const kept = argv.slice(0, MAX_ARGV_TOKENS).map(truncateToken);
  return argv.length > MAX_ARGV_TOKENS ? [...kept, `…(+${String(argv.length - MAX_ARGV_TOKENS)})`] : kept;
}

function auditPath(root: string, target: string): string {
  const absolute = path.resolve(root, target);
  const relative = path.relative(root, absolute);
  if (relative === "") {
    return ".";
  }
  return relative.startsWith("..") || path.isAbsolute(relative) ? absolute : relative.split(path.sep).join("/");
}

function auditTarget(root: string, request: Exclude<PermissionRequest, { kind: "none" }>): string[] {
  return request.kind === "exec" ? auditArgv(request.argv) : request.paths.map((target) => auditPath(root, target));
}

function invalidInputs(record: EventRecord): number {
  if (record.type !== "message" || record.message.role !== "user") {
    return 0;
  }
  return record.message.parts.filter((part) => part.type === "tool-result" && part.isError && part.content.startsWith(INVALID_INPUT_PREFIX)).length;
}

function commandKey(command: TeamCommand): string {
  return JSON.stringify(command.argv);
}

export class CommandApprovalTracker {
  readonly #confirmed = new Map<string, ApprovalSource>();
  readonly #source: ApprovalSource;

  constructor(source: "tty" | "yes-verify") {
    this.#source = source;
  }

  wrap(approver: CommandApprover): CommandApprover {
    return async (commands, purpose) => {
      const approved = await approver(commands, purpose);
      if (approved) {
        for (const command of commands) {
          this.#confirmed.set(commandKey(command), this.#source);
        }
      }
      return approved;
    };
  }

  sourceOf(command: TeamCommand): ApprovalSource {
    return this.#confirmed.get(commandKey(command)) ?? "rule";
  }
}

function uniqueCommands(commands: readonly TeamCommand[]): TeamCommand[] {
  const seen = new Map<string, TeamCommand>();
  for (const command of commands) {
    seen.set(commandKey(command), command);
  }
  return [...seen.values()];
}

export class AuditRecorder {
  readonly #ledger: AuditLedger;
  readonly #root: string;
  #invalidInputs = 0;

  constructor(ledger: AuditLedger, root: string) {
    this.#ledger = ledger;
    this.#root = root;
  }

  get invalidInputs(): number {
    return this.#invalidInputs;
  }

  start(input: RunStartInput): void {
    this.#ledger.record({
      kind: "run-start",
      command: input.command,
      roles: Object.fromEntries(
        Object.entries(input.roles).map(([role, ref]) => [role, { model: `${ref.provider}:${ref.id}`, effort: ref.effort ?? "provider-default" }]),
      ),
      budget: input.budget,
      taskSha256: createHash("sha256").update(input.task).digest("hex"),
      taskPrefix: input.task.slice(0, TASK_PREFIX_CHARS),
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    });
  }

  tap(inner: EventSink & { close?(): Promise<void> }, sessionId: string, role: AgentRole): TeamSessionLog {
    return {
      append: async (body: EventBody) => {
        const record = await inner.append(body);
        this.#observe(record, sessionId, role);
        return record;
      },
      close: async () => {
        await inner.close?.();
      },
    };
  }

  teamOutcome(outcome: TeamOutcome, trusted: boolean, tracker: CommandApprovalTracker | undefined): void {
    const approved = uniqueCommands(outcome.verificationRuns.map((run) => run.command));
    const unapprovedSource: ApprovalSource = trusted ? "not-approved" : "untrusted-skip";
    this.#ledger.record({
      kind: "run-outcome",
      status: outcome.status,
      ...(outcome.code === undefined ? {} : { code: outcome.code }),
      revisions: outcome.revisions,
      ...(outcome.planCorrections === undefined ? {} : { planCorrections: outcome.planCorrections }),
      invalidInputs: this.#invalidInputs,
      usage: outcome.usage,
      usageByRole: outcome.usageByRole ?? {},
      verification: outcome.verification,
      approvedCommands: approved.map((command): AuditedCommand => ({ argv: auditArgv(command.argv), source: tracker?.sourceOf(command) ?? "rule" })),
      unapprovedCommands: uniqueCommands(outcome.unapprovedCommands).map((command) => ({ argv: auditArgv(command.argv), source: unapprovedSource })),
      ...(outcome.commit === undefined ? {} : { commit: outcome.commit }),
      ...(outcome.branch === undefined ? {} : { branch: outcome.branch }),
    });
  }

  runOutcome(outcome: TurnOutcome, role: AgentRole, usage: UsageTotals): void {
    this.#ledger.record({
      kind: "run-outcome",
      status: outcome.type,
      ...(outcome.type === "failed" ? { code: outcome.code } : {}),
      invalidInputs: this.#invalidInputs,
      usage,
      usageByRole: { [role]: usage },
      approvedCommands: [],
      unapprovedCommands: [],
    });
  }

  #observe(record: EventRecord, sessionId: string, role: AgentRole): void {
    this.#invalidInputs += invalidInputs(record);
    if (record.type !== "permission" || record.request.kind === "none") {
      return;
    }
    this.#ledger.record({
      kind: "permission",
      role,
      sessionId,
      action: record.request.kind,
      target: auditTarget(this.#root, record.request),
      allowed: record.allowed,
      source: record.source,
      ...(record.approval === undefined ? {} : { approval: record.approval }),
    });
  }
}
