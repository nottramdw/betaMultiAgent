import type { Environment } from "../environment/environment.js";
import type { PermissionRequest, PermissionVerdict } from "../permissions/permission-types.js";
import type { Redactor } from "../redaction/redaction.js";
import type { TeamCommand } from "./completion-tools.js";

export const OUTPUT_TAIL_BYTES = 8 * 1024;

export interface CommandPolicy {
  evaluate(request: PermissionRequest): Promise<PermissionVerdict>;
}

export type CommandPurpose = "setup" | "verify";

export type CommandApprover = (commands: readonly TeamCommand[], purpose: CommandPurpose) => Promise<boolean>;

export interface CommandVerdict {
  readonly command: TeamCommand;
  readonly decision: PermissionVerdict["decision"];
  readonly reason: string;
}

export interface CommandApproval {
  readonly approved: readonly TeamCommand[];
  readonly unapproved: readonly TeamCommand[];
  readonly denied: readonly CommandVerdict[];
}

export interface CommandRun {
  readonly command: TeamCommand;
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly outputTail: string;
}

export interface ApproveCommandsOptions {
  readonly policy: CommandPolicy;
  readonly cwd: string;
  readonly trusted: boolean;
  readonly purpose: CommandPurpose;
  readonly approver?: CommandApprover;
}

export async function evaluateCommands(
  commands: readonly TeamCommand[],
  policy: CommandPolicy,
  cwd: string,
): Promise<CommandVerdict[]> {
  const verdicts: CommandVerdict[] = [];
  for (const command of commands) {
    const verdict = await policy.evaluate({ kind: "exec", argv: [...command.argv], cwd });
    verdicts.push({ command, decision: verdict.decision, reason: verdict.reason });
  }
  return verdicts;
}

export async function approveCommands(
  commands: readonly TeamCommand[],
  options: ApproveCommandsOptions,
): Promise<CommandApproval> {
  const verdicts = await evaluateCommands(commands, options.policy, options.cwd);
  const denied = verdicts.filter((verdict) => verdict.decision === "deny");
  const runnable = verdicts.filter((verdict) => verdict.decision !== "deny");
  if (!options.trusted) {
    return { approved: [], unapproved: runnable.map((verdict) => verdict.command), denied };
  }
  const pending = runnable.filter((verdict) => verdict.decision === "ask").map((verdict) => verdict.command);
  const confirmed =
    pending.length > 0 && options.approver !== undefined ? await options.approver(pending, options.purpose) : false;
  const accepted = new Set<TeamCommand>(confirmed ? runnable.map((verdict) => verdict.command) : []);
  for (const verdict of runnable) {
    if (verdict.decision === "allow") {
      accepted.add(verdict.command);
    }
  }
  return {
    approved: runnable.map((verdict) => verdict.command).filter((command) => accepted.has(command)),
    unapproved: runnable.map((verdict) => verdict.command).filter((command) => !accepted.has(command)),
    denied,
  };
}

function isContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

export function tailText(text: string, limitBytes: number = OUTPUT_TAIL_BYTES): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limitBytes) {
    return text;
  }
  let start = bytes.length - limitBytes;
  while (start < bytes.length && isContinuationByte(bytes[start])) {
    start += 1;
  }
  return `[... ${String(start)} bytes omitted ...]\n${bytes.subarray(start).toString("utf8")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface RunCommandsOptions {
  readonly redactor: Redactor;
  readonly signal: AbortSignal;
}

export async function runCommands(
  environment: Environment,
  commands: readonly TeamCommand[],
  options: RunCommandsOptions,
): Promise<CommandRun[]> {
  const runs: CommandRun[] = [];
  for (const command of commands) {
    if (options.signal.aborted) {
      break;
    }
    let run: CommandRun;
    try {
      const result = await environment.exec(command.argv, {
        cwd: environment.root,
        signal: options.signal,
        ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
      });
      const output = [result.stdout, result.stderr].filter((part) => part.length > 0).join("\n");
      run = {
        command,
        ok: result.exitCode === 0 && !result.timedOut,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        outputTail: tailText(options.redactor.redact(output)),
      };
    } catch (error) {
      run = {
        command,
        ok: false,
        exitCode: null,
        timedOut: false,
        durationMs: 0,
        outputTail: tailText(options.redactor.redact(errorMessage(error))),
      };
    }
    runs.push(run);
    if (!run.ok) {
      break;
    }
  }
  return runs;
}
