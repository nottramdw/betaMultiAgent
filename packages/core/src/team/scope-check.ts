import path from "node:path";
import { compileMatcher, SECRET_EXCEPTIONS, SECRET_PATTERNS, SENSITIVE_WRITE_PATTERNS } from "../permissions/path-patterns.js";

export interface ScopeRules {
  readonly inScope: readonly string[];
  readonly outOfScope: readonly string[];
}

export interface ChangeClassification {
  readonly sensitive: readonly string[];
  readonly outOfScope: readonly string[];
}

export function scopePatternProblem(pattern: string): string | undefined {
  if (pattern.trim().length === 0) {
    return "is empty";
  }
  if (pattern.includes("\0")) {
    return "contains a NUL character";
  }
  if (pattern.includes("\\")) {
    return "must use forward slashes";
  }
  if (pattern.startsWith("/") || /^[A-Za-z]:/u.test(pattern)) {
    return "must be relative to the workspace root";
  }
  if (pattern.split("/").includes("..")) {
    return "must not contain '..'";
  }
  return undefined;
}

export function scopeProblems(rules: ScopeRules): string[] {
  const problems: string[] = [];
  for (const [field, patterns] of [
    ["inScope", rules.inScope],
    ["outOfScope", rules.outOfScope],
  ] as const) {
    for (const pattern of patterns) {
      const problem = scopePatternProblem(pattern);
      if (problem !== undefined) {
        problems.push(`${field} pattern ${JSON.stringify(pattern)} ${problem}`);
      }
    }
  }
  return problems;
}

export function classifyChanges(paths: readonly string[], rules: ScopeRules, nocase: boolean): ChangeClassification {
  const secret = compileMatcher(SECRET_PATTERNS, true);
  const secretException = compileMatcher(SECRET_EXCEPTIONS, true);
  const sensitiveWrite = compileMatcher(SENSITIVE_WRITE_PATTERNS, nocase);
  const inScope = compileMatcher(rules.inScope, nocase);
  const outOfScope = compileMatcher(rules.outOfScope, nocase);
  const sensitive: string[] = [];
  const outside: string[] = [];
  for (const item of paths) {
    if (sensitiveWrite(item) || (secret(item) && !secretException(item))) {
      sensitive.push(item);
    }
    if (!inScope(item) || outOfScope(item)) {
      outside.push(item);
    }
  }
  return { sensitive, outOfScope: outside };
}

export function toRelativePosix(root: string, target: string): string | undefined {
  const relative = path.relative(root, path.resolve(root, target));
  if (relative.length === 0 || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    return undefined;
  }
  return relative.split(path.sep).join("/");
}
