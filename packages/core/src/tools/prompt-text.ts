import type { Redactor } from "../redaction/redaction.js";

export const PROMPT_TEXT_LIMIT_BYTES = 40 * 1024;

function isContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

export function truncateMiddle(text: string, limitBytes: number = PROMPT_TEXT_LIMIT_BYTES): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limitBytes) {
    return text;
  }
  const marker = (omitted: number): string => `\n[... ${String(omitted)} bytes truncated ...]\n`;
  const budget = Math.max(0, limitBytes - Buffer.byteLength(marker(bytes.length), "utf8"));
  let headEnd = Math.ceil(budget / 2);
  let tailStart = bytes.length - Math.floor(budget / 2);
  while (headEnd > 0 && isContinuationByte(bytes[headEnd])) {
    headEnd -= 1;
  }
  while (tailStart < bytes.length && isContinuationByte(bytes[tailStart])) {
    tailStart += 1;
  }
  const head = bytes.subarray(0, headEnd).toString("utf8");
  const tail = bytes.subarray(tailStart).toString("utf8");
  return head + marker(tailStart - headEnd) + tail;
}

export function finalizePromptText(text: string, redactor: Redactor, limitBytes: number = PROMPT_TEXT_LIMIT_BYTES): string {
  return truncateMiddle(redactor.redact(text), limitBytes);
}
