import { textOf, toolCalls, type AssistantMessage, type Message, type SystemNote, type UserMessage } from "../messages/messages.js";
import { truncateMiddle } from "../tools/prompt-text.js";
import { canonicalJson } from "./loop-detector.js";

export const COMPACTION_SECTIONS = [
  "Goal",
  "Constraints",
  "Decisions",
  "Completed work",
  "Files touched",
  "Current state",
  "Open issues",
  "Next steps",
  "References",
] as const;

export const MIN_SUMMARY_CHARS = 500;
export const TRANSCRIPT_RESULT_LIMIT_BYTES = 2 * 1024;
export const TRANSCRIPT_INPUT_LIMIT_BYTES = 512;
export const CHARS_PER_TOKEN = 3;

const INSTRUCTIONS = [
  "Summarize the conversation so far so that the work can continue from your summary alone.",
  "Reply with text only and do not call any tool.",
  `Use exactly these Markdown level-2 headings, in this order: ${COMPACTION_SECTIONS.join("; ")}.`,
  "Under References, list the file paths, commands, identifiers, and URLs needed to resume.",
].join(" ");

export function compactionNote(): SystemNote {
  return { role: "system", reason: "compaction", text: INSTRUCTIONS };
}

export type SummaryCheck = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string };

function headingSet(text: string): Set<string> {
  return new Set(
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("#"))
      .map((line) =>
        line
          .replace(/^#+/u, "")
          .replace(/:$/u, "")
          .trim()
          .toLowerCase(),
      ),
  );
}

export function checkSummary(message: AssistantMessage): SummaryCheck {
  if (toolCalls(message).length > 0) {
    return { ok: false, reason: "summary contained tool calls" };
  }
  const text = textOf(message).trim();
  if (text.length < MIN_SUMMARY_CHARS) {
    return { ok: false, reason: `summary is shorter than ${String(MIN_SUMMARY_CHARS)} characters` };
  }
  const headings = headingSet(text);
  const missing = COMPACTION_SECTIONS.filter((section) => !headings.has(section.toLowerCase()));
  if (missing.length > 0) {
    return { ok: false, reason: `summary is missing sections: ${missing.join(", ")}` };
  }
  return { ok: true, text };
}

function transcriptEntries(history: readonly Message[]): string[] {
  const entries: string[] = [];
  for (const message of history) {
    if (message.role === "system" || (message.role === "user" && message.synthetic === "project-context")) {
      continue;
    }
    for (const part of message.parts) {
      if (part.type === "text") {
        entries.push(`[${message.role}] ${part.text}`);
      } else if (part.type === "tool-result") {
        const label = part.isError ? "tool-result error" : "tool-result";
        entries.push(`[${label}] ${truncateMiddle(part.content, TRANSCRIPT_RESULT_LIMIT_BYTES)}`);
      } else if (part.type === "tool-call") {
        const input = truncateMiddle(canonicalJson(part.input), TRANSCRIPT_INPUT_LIMIT_BYTES);
        entries.push(`[tool-call ${part.name}] ${input}`);
      }
    }
  }
  return entries;
}

export function neutralTranscript(history: readonly Message[], budgetChars: number): string {
  const entries = transcriptEntries(history);
  const kept: string[] = [];
  let used = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] ?? "";
    if (used + entry.length + 1 > budgetChars) {
      if (kept.length === 0) {
        kept.push(truncateMiddle(entry, Math.max(0, budgetChars)));
      }
      break;
    }
    kept.unshift(entry);
    used += entry.length + 1;
  }
  return kept.join("\n");
}

export function transcriptRequestMessage(transcript: string): UserMessage {
  return {
    role: "user",
    synthetic: "compaction",
    parts: [{ type: "text", text: `${INSTRUCTIONS}\n\n<transcript>\n${transcript}\n</transcript>` }],
  };
}

export interface CompactedHistoryInput {
  readonly projectContext?: UserMessage;
  readonly originalInput?: string;
  readonly summary: string;
  readonly logPath?: string;
}

export function compactedHistory(input: CompactedHistoryInput): Message[] {
  const lines = [
    "Earlier conversation was compacted. Continue the task from this summary.",
    "",
    "## Original task",
    input.originalInput ?? "(unavailable)",
    "",
    input.summary,
  ];
  if (input.logPath !== undefined) {
    lines.push("", `Full event log: ${input.logPath}`);
  }
  const summary: UserMessage = { role: "user", synthetic: "compaction", parts: [{ type: "text", text: lines.join("\n") }] };
  return input.projectContext === undefined ? [summary] : [input.projectContext, summary];
}
