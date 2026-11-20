import type { Redactor } from "@betamultiagent/core";
import { ApprovalQueue, LineReader } from "../approver/approval-queue.js";
import type { PromptChannel } from "../approver/tty-approver.js";
import type { CliIo } from "../cli-io.js";
import { TerminalWriter } from "../output/human.js";
import type { WiringOverrides } from "../wiring.js";

export interface MainOverrides extends WiringOverrides {
  readonly killProcessTrees?: () => readonly number[];
}

export interface CommandContext {
  readonly io: CliIo;
  readonly redactor: Redactor;
  readonly out: TerminalWriter;
  readonly err: TerminalWriter;
  readonly overrides: MainOverrides;
}

export function createCommandContext(io: CliIo, redactor: Redactor, overrides: MainOverrides): CommandContext {
  return {
    io,
    redactor,
    out: new TerminalWriter(io.stdout, redactor),
    err: new TerminalWriter(io.stderr, redactor),
    overrides,
  };
}

export function isInteractive(context: CommandContext, json: boolean): boolean {
  return !json && context.io.stdinIsTTY && context.io.stderr.isTTY;
}

export interface OpenedChannel {
  readonly channel: PromptChannel;
  close(): void;
}

export function openPromptChannel(context: CommandContext): OpenedChannel {
  const reader = new LineReader(context.io.stdin);
  return {
    channel: { queue: new ApprovalQueue(), reader, writer: context.err },
    close: () => {
      reader.close();
    },
  };
}

export async function confirm(context: CommandContext, question: string): Promise<boolean> {
  const opened = openPromptChannel(context);
  try {
    context.err.write(question);
    const answer = (await opened.channel.reader.next())?.trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    opened.close();
  }
}
