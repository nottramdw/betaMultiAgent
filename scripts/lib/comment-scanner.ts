import { basename, extname } from "node:path";
import ts from "typescript";

export interface Finding {
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

interface Span {
  readonly start: number;
  readonly end: number;
}

const SCRIPT_KINDS: ReadonlyMap<string, ts.ScriptKind> = new Map([
  [".ts", ts.ScriptKind.TS],
  [".mts", ts.ScriptKind.TS],
  [".cts", ts.ScriptKind.TS],
  [".js", ts.ScriptKind.JS],
  [".mjs", ts.ScriptKind.JS],
  [".cjs", ts.ScriptKind.JS],
]);

const UNSUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set([".tsx", ".jsx"]);

const LINE_COMMENT_MARKERS: ReadonlyMap<string, readonly string[]> = new Map([
  [".gitignore", ["#"]],
  [".gitattributes", ["#"]],
  [".npmrc", ["#", ";"]],
  [".editorconfig", ["#", ";"]],
]);

const GENERATED_FILES: ReadonlySet<string> = new Set(["pnpm-lock.yaml", "Cargo.lock"]);

export function scanFile(path: string, rawText: string): Finding[] {
  const text = rawText.replaceAll("\r\n", "\n");
  const name = basename(path);
  if (GENERATED_FILES.has(name)) {
    return [];
  }
  const markers = LINE_COMMENT_MARKERS.get(name);
  if (markers !== undefined) {
    return toFindings(text, findLineComments(text, markers));
  }
  const extension = extname(name).toLowerCase();
  const scriptKind = SCRIPT_KINDS.get(extension);
  if (scriptKind !== undefined) {
    return toFindings(text, findScriptComments(path, text, scriptKind));
  }
  if (UNSUPPORTED_EXTENSIONS.has(extension)) {
    return [{ line: 1, column: 1, message: "unsupported source type" }];
  }
  switch (extension) {
    case ".rs":
      return toFindings(text, findRustComments(text));
    case ".toml":
      return toFindings(text, findTomlComments(text));
    case ".yml":
    case ".yaml":
      return toFindings(text, findYamlComments(text));
    case ".json":
      return isStrictJson(text) ? [] : [{ line: 1, column: 1, message: "not strict JSON" }];
    default:
      return [];
  }
}

function findScriptComments(fileName: string, text: string, scriptKind: ts.ScriptKind): Span[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind);
  const spans = new Map<number, Span>();
  const collect = (ranges: readonly ts.CommentRange[] | undefined): void => {
    for (const range of ranges ?? []) {
      spans.set(range.pos, { start: range.pos, end: range.end });
    }
  };
  const visit = (node: ts.Node): void => {
    collect(ts.getLeadingCommentRanges(text, node.pos));
    collect(ts.getTrailingCommentRanges(text, node.end));
    for (const child of node.getChildren(source)) {
      visit(child);
    }
  };
  visit(source);
  return [...spans.values()].sort((left, right) => left.start - right.start);
}

function findRustComments(text: string): Span[] {
  const spans: Span[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text.charAt(index);
    const next = text.charAt(index + 1);
    if (char === "/" && next === "/") {
      const end = lineEnd(text, index);
      spans.push({ start: index, end });
      index = end;
    } else if (char === "/" && next === "*") {
      const end = skipNestedBlockComment(text, index);
      spans.push({ start: index, end });
      index = end;
    } else if (char === '"') {
      index = skipEscapedQuote(text, index + 1, '"');
    } else if (char === "'") {
      index = skipCharOrLifetime(text, index);
    } else if (IDENTIFIER_START.test(char)) {
      index = skipWordOrPrefixedLiteral(text, index);
    } else {
      index += 1;
    }
  }
  return spans;
}

const IDENTIFIER_START = /^[\p{XID_Start}_]$/u;
const IDENTIFIER_CONTINUE = /^\p{XID_Continue}$/u;

function skipWordOrPrefixedLiteral(text: string, start: number): number {
  let end = start;
  while (end < text.length && IDENTIFIER_CONTINUE.test(text.charAt(end))) {
    end += 1;
  }
  const word = text.slice(start, end);
  const after = text.charAt(end);
  if ((word === "r" || word === "br" || word === "cr") && (after === '"' || after === "#")) {
    const rawEnd = skipRawString(text, end);
    if (rawEnd !== undefined) {
      return rawEnd;
    }
  }
  if ((word === "b" || word === "c") && after === '"') {
    return skipEscapedQuote(text, end + 1, '"');
  }
  if (word === "b" && after === "'") {
    return skipEscapedQuote(text, end + 1, "'");
  }
  return end;
}

function skipRawString(text: string, from: number): number | undefined {
  let cursor = from;
  while (text.charAt(cursor) === "#") {
    cursor += 1;
  }
  if (text.charAt(cursor) !== '"') {
    return undefined;
  }
  const terminator = `"${"#".repeat(cursor - from)}`;
  const close = text.indexOf(terminator, cursor + 1);
  return close === -1 ? text.length : close + terminator.length;
}

function skipCharOrLifetime(text: string, start: number): number {
  if (text.charAt(start + 1) === "\\") {
    return skipEscapedQuote(text, start + 1, "'");
  }
  const codePoint = text.codePointAt(start + 1);
  if (codePoint === undefined) {
    return start + 1;
  }
  const width = codePoint > 0xffff ? 2 : 1;
  return text.charAt(start + 1 + width) === "'" ? start + 2 + width : start + 1;
}

function skipNestedBlockComment(text: string, start: number): number {
  let depth = 0;
  let cursor = start;
  while (cursor < text.length) {
    if (text.startsWith("/*", cursor)) {
      depth += 1;
      cursor += 2;
    } else if (text.startsWith("*/", cursor)) {
      depth -= 1;
      cursor += 2;
      if (depth === 0) {
        return cursor;
      }
    } else {
      cursor += 1;
    }
  }
  return text.length;
}

function skipEscapedQuote(text: string, from: number, quote: string): number {
  let cursor = from;
  while (cursor < text.length) {
    const char = text.charAt(cursor);
    if (char === "\\") {
      cursor += 2;
    } else if (char === quote) {
      return cursor + 1;
    } else {
      cursor += 1;
    }
  }
  return text.length;
}

function findTomlComments(text: string): Span[] {
  const spans: Span[] = [];
  let index = 0;
  while (index < text.length) {
    if (text.startsWith('"""', index)) {
      index = skipTomlMultiline(text, index + 3, '"', true);
    } else if (text.startsWith("'''", index)) {
      index = skipTomlMultiline(text, index + 3, "'", false);
    } else {
      const char = text.charAt(index);
      if (char === '"') {
        index = skipSingleLineQuote(text, index + 1, '"', true);
      } else if (char === "'") {
        index = skipSingleLineQuote(text, index + 1, "'", false);
      } else if (char === "#") {
        const end = lineEnd(text, index);
        spans.push({ start: index, end });
        index = end;
      } else {
        index += 1;
      }
    }
  }
  return spans;
}

function skipTomlMultiline(text: string, from: number, quote: string, escapes: boolean): number {
  const delimiter = quote.repeat(3);
  let cursor = from;
  while (cursor < text.length) {
    if (escapes && text.charAt(cursor) === "\\") {
      cursor += 2;
    } else if (text.startsWith(delimiter, cursor)) {
      cursor += 3;
      let extra = 0;
      while (extra < 2 && text.charAt(cursor) === quote) {
        cursor += 1;
        extra += 1;
      }
      return cursor;
    } else {
      cursor += 1;
    }
  }
  return text.length;
}

function skipSingleLineQuote(text: string, from: number, quote: string, escapes: boolean): number {
  let cursor = from;
  while (cursor < text.length) {
    const char = text.charAt(cursor);
    if (char === "\n") {
      return cursor;
    }
    if (escapes && char === "\\") {
      cursor += 2;
    } else if (char === quote) {
      return cursor + 1;
    } else {
      cursor += 1;
    }
  }
  return text.length;
}

const BLOCK_SCALAR_HEADER = /^[|>](?:[+-]?[1-9]?|[1-9][+-])[ \t]*(?:#[^\n]*)?(?:\n|$)/u;

function lineStartOf(text: string, index: number): number {
  return text.lastIndexOf("\n", index - 1) + 1;
}

function indentOf(text: string, start: number): number {
  let cursor = start;
  while (text.charAt(cursor) === " ") {
    cursor += 1;
  }
  return cursor - start;
}

function isBlockScalarHeader(text: string, index: number): boolean {
  const before = text.slice(lineStartOf(text, index), index).trimEnd();
  const opensValue = before.endsWith(":") || before.endsWith("-") || before === "";
  return opensValue && /\s/u.test(text.charAt(index - 1)) && BLOCK_SCALAR_HEADER.test(text.slice(index));
}

function skipBlockScalar(text: string, from: number, parentIndent: number): number {
  let start = from;
  while (start < text.length) {
    const end = lineEnd(text, start);
    const line = text.slice(start, end);
    if (line.trim() !== "" && indentOf(text, start) <= parentIndent) {
      return start;
    }
    start = end + 1;
  }
  return text.length;
}

function findYamlComments(text: string): Span[] {
  const spans: Span[] = [];
  let quote = "";
  let blockParentIndent: number | null = null;
  let index = 0;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === "\n") {
      quote = "";
      index += 1;
      if (blockParentIndent !== null) {
        index = skipBlockScalar(text, index, blockParentIndent);
        blockParentIndent = null;
      }
    } else if (quote === '"') {
      if (char === "\\") {
        index += 2;
      } else {
        if (char === '"') {
          quote = "";
        }
        index += 1;
      }
    } else if (quote === "'") {
      if (char === "'" && text.charAt(index + 1) === "'") {
        index += 2;
      } else {
        if (char === "'") {
          quote = "";
        }
        index += 1;
      }
    } else {
      const previous = index === 0 ? "\n" : text.charAt(index - 1);
      const atBoundary = /\s/u.test(previous);
      if (char === "#" && atBoundary) {
        const end = lineEnd(text, index);
        spans.push({ start: index, end });
        index = end;
      } else if ((char === "|" || char === ">") && isBlockScalarHeader(text, index)) {
        blockParentIndent = indentOf(text, lineStartOf(text, index));
        index += 1;
      } else {
        if ((char === '"' || char === "'") && (atBoundary || "[{,".includes(previous))) {
          quote = char;
        }
        index += 1;
      }
    }
  }
  return spans;
}

function findLineComments(text: string, markers: readonly string[]): Span[] {
  const spans: Span[] = [];
  let lineStart = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trimStart();
    if (markers.some((marker) => trimmed.startsWith(marker))) {
      spans.push({ start: lineStart + line.length - trimmed.length, end: lineStart + line.length });
    }
    lineStart += line.length + 1;
  }
  return spans;
}

function isStrictJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function lineEnd(text: string, from: number): number {
  const newline = text.indexOf("\n", from);
  return newline === -1 ? text.length : newline;
}

function toFindings(text: string, spans: readonly Span[]): Finding[] {
  return spans.map((span) => {
    const before = text.slice(0, span.start);
    const line = before.split("\n").length;
    const column = span.start - before.lastIndexOf("\n");
    const snippet = text.slice(span.start, Math.min(span.end, lineEnd(text, span.start), span.start + 60));
    return { line, column, message: `comment ${JSON.stringify(snippet)}` };
  });
}
