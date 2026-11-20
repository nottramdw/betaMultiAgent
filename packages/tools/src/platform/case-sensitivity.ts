import { statSync } from "node:fs";
import path from "node:path";
import { isMissingError } from "./errors.js";

function swapAsciiCase(text: string): string {
  return text.replace(/[A-Za-z]/gu, (letter) => (letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase()));
}

export function defaultCaseSensitivity(platform: NodeJS.Platform): boolean {
  return platform !== "win32" && platform !== "darwin";
}

export function detectCaseSensitivity(root: string, fallback: boolean): boolean {
  const parsed = path.parse(root);
  const segments = root.slice(parsed.root.length).split(path.sep);
  let index = segments.length - 1;
  while (index >= 0 && !/[A-Za-z]/u.test(segments[index] ?? "")) {
    index -= 1;
  }
  if (index < 0) {
    return fallback;
  }
  const swapped = segments.map((segment, position) => (position === index ? swapAsciiCase(segment) : segment));
  const candidate = path.join(parsed.root, ...swapped);
  try {
    const original = statSync(root, { bigint: true });
    const other = statSync(candidate, { bigint: true });
    return !(original.dev === other.dev && original.ino === other.ino);
  } catch (error) {
    return isMissingError(error) ? true : fallback;
  }
}
