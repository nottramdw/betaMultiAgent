import type { ApprovalAnswer, Approver, CommandApprover, PermissionVerdict, TeamCommand } from "@betamultiagent/core";
import type { TerminalWriter } from "../output/human.js";
import { describeRequest } from "../output/human.js";
import { displayArgv } from "../output/sanitize.js";
import type { ApprovalQueue, LineReader } from "./approval-queue.js";

export interface PromptChannel {
  readonly queue: ApprovalQueue;
  readonly reader: LineReader;
  readonly writer: TerminalWriter;
}

async function ask(channel: PromptChannel, question: string): Promise<string | undefined> {
  channel.writer.write(question);
  const line = await channel.reader.next();
  return line?.trim().toLowerCase();
}

export function createTtyApprover(channel: PromptChannel, agentName: string): Approver {
  return (request, verdict: PermissionVerdict) =>
    channel.queue.run(async (): Promise<ApprovalAnswer> => {
      channel.writer.line("");
      channel.writer.line(`[${agentName}] requests permission: ${describeRequest(request)}`);
      channel.writer.line(`  reason: ${verdict.reason}`);
      if (verdict.sensitive) {
        channel.writer.line("  WARNING: this write targets a sensitive file (build, CI, package or agent configuration).");
      }
      const choices = verdict.sensitive ? "[y] once, [n] deny" : "[y] once, [n] deny, [a] allow this exact request for the session";
      for (;;) {
        const answer = await ask(channel, `  allow? ${choices}: `);
        if (answer === undefined || answer === "n" || answer === "no") {
          return "deny";
        }
        if (answer === "y" || answer === "yes") {
          return "allow-once";
        }
        if (answer === "a" && !verdict.sensitive) {
          return "allow-session";
        }
      }
    });
}

export function createTtyCommandApprover(channel: PromptChannel): CommandApprover {
  return (commands: readonly TeamCommand[], purpose) =>
    channel.queue.run(async () => {
      channel.writer.line("");
      channel.writer.line(`[team] the plan wants to run ${String(commands.length)} ${purpose} command(s) in the worktree:`);
      for (const command of commands) {
        channel.writer.line(`  ${displayArgv(command.argv)}`);
      }
      channel.writer.line("  allowing a runner such as node, pnpm or python allows arbitrary code execution.");
      const answer = await ask(channel, "  run them? [y/N]: ");
      return answer === "y" || answer === "yes";
    });
}
