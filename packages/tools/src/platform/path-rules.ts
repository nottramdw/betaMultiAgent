import { PathEscapeError } from "@betamultiagent/core";

const DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|CLOCK\$|COM[0-9¹²³]|LPT[0-9¹²³])$/iu;
const INVALID_SEGMENT_CHARS = /[<>"|?*]/u;
const TRAILING_DOT_OR_SPACE = /[. ]$/u;

export function assertLexicallySafe(input: string, platform: NodeJS.Platform): string {
  if (input.length === 0) {
    throw new PathEscapeError(input, "empty path");
  }
  if (input.includes("\0")) {
    throw new PathEscapeError(input, "path contains a NUL character");
  }
  if (platform !== "win32") {
    return input;
  }
  const normalized = input.replaceAll("/", "\\");
  if (normalized.startsWith("\\\\")) {
    throw new PathEscapeError(input, "UNC and device paths are not permitted");
  }
  if (normalized.startsWith("\\??\\")) {
    throw new PathEscapeError(input, "NT namespace paths are not permitted");
  }
  let rest = normalized;
  if (/^[A-Za-z]:/u.test(normalized)) {
    if (normalized[2] !== "\\") {
      throw new PathEscapeError(input, "drive-relative paths are not permitted");
    }
    rest = normalized.slice(3);
  }
  for (const segment of rest.split("\\")) {
    if (segment === "" || segment === "." || segment === "..") {
      continue;
    }
    if (segment.includes(":")) {
      throw new PathEscapeError(input, "alternate data streams are not permitted");
    }
    if (INVALID_SEGMENT_CHARS.test(segment)) {
      throw new PathEscapeError(input, "path contains characters that are invalid on Windows");
    }
    if (TRAILING_DOT_OR_SPACE.test(segment)) {
      throw new PathEscapeError(input, "path segments ending in a dot or space are not permitted");
    }
    const stem = (segment.split(".")[0] ?? "").trimEnd();
    if (DEVICE_NAME.test(stem)) {
      throw new PathEscapeError(input, "reserved Windows device names are not permitted");
    }
  }
  return normalized;
}
