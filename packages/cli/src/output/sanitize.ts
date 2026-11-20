const ESC = 0x1b;
const BEL = 0x07;
const CSI_C1 = 0x9b;
const OSC_C1 = 0x9d;
const ST_C1 = 0x9c;

export const DEFAULT_DISPLAY_LIMIT = 200;

function isDropped(code: number): boolean {
  if (code === 0x0a || code === 0x09) {
    return false;
  }
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}

function skipCsi(codes: readonly number[], start: number): number {
  let index = start;
  while (index < codes.length && (codes[index] ?? 0) >= 0x30 && (codes[index] ?? 0) <= 0x3f) {
    index += 1;
  }
  while (index < codes.length && (codes[index] ?? 0) >= 0x20 && (codes[index] ?? 0) <= 0x2f) {
    index += 1;
  }
  return index < codes.length && (codes[index] ?? 0) >= 0x40 && (codes[index] ?? 0) <= 0x7e ? index + 1 : index;
}

function skipString(codes: readonly number[], start: number, allowBel: boolean): number {
  let index = start;
  while (index < codes.length) {
    const code = codes[index] ?? 0;
    if ((allowBel && code === BEL) || code === ST_C1) {
      return index + 1;
    }
    if (code === ESC && codes[index + 1] === 0x5c) {
      return index + 2;
    }
    index += 1;
  }
  return index;
}

function skipEscape(codes: readonly number[], start: number): number {
  const next = codes[start + 1];
  if (next === undefined) {
    return start + 1;
  }
  if (next === 0x5b) {
    return skipCsi(codes, start + 2);
  }
  if (next === 0x5d) {
    return skipString(codes, start + 2, true);
  }
  if (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
    return skipString(codes, start + 2, false);
  }
  let index = start + 1;
  while (index < codes.length && (codes[index] ?? 0) >= 0x20 && (codes[index] ?? 0) <= 0x2f) {
    index += 1;
  }
  return index < codes.length && (codes[index] ?? 0) >= 0x30 && (codes[index] ?? 0) <= 0x7e ? index + 1 : index;
}

export function sanitizeTerminal(text: string): string {
  const chars = Array.from(text);
  const codes = chars.map((char) => char.codePointAt(0) ?? 0);
  const out: string[] = [];
  let index = 0;
  while (index < codes.length) {
    const code = codes[index] ?? 0;
    if (code === ESC) {
      index = skipEscape(codes, index);
    } else if (code === CSI_C1) {
      index = skipCsi(codes, index + 1);
    } else if (code === OSC_C1) {
      index = skipString(codes, index + 1, true);
    } else {
      if (!isDropped(code)) {
        out.push(chars[index] ?? "");
      }
      index += 1;
    }
  }
  return out.join("");
}

export function truncateDisplay(text: string, limit = DEFAULT_DISPLAY_LIMIT): string {
  const chars = Array.from(text);
  if (chars.length <= limit) {
    return text;
  }
  return `${chars.slice(0, limit).join("")}... (${String(chars.length)} chars)`;
}

export function displayArgv(argv: readonly string[], limit = DEFAULT_DISPLAY_LIMIT): string {
  return truncateDisplay(sanitizeTerminal(JSON.stringify(argv)), limit);
}

export function displayValue(value: unknown, limit = DEFAULT_DISPLAY_LIMIT): string {
  const json = typeof value === "string" ? value : (JSON.stringify(value) as string | undefined);
  const text = json ?? String(value);
  return truncateDisplay(sanitizeTerminal(text), limit);
}
