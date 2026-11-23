import { PermissionConfigError, type ExecRule } from "./permission-types.js";

const EXECUTABLE_SUFFIX = /\.(?:exe|com|cmd|bat)$/iu;

export const EXACT_ONLY_PROGRAMS: ReadonlySet<string> = new Set([
  "git",
  "gh",
  "npm",
  "npx",
  "pnpm",
  "pnpx",
  "yarn",
  "bun",
  "bunx",
  "deno",
  "corepack",
  "node",
  "python",
  "python3",
  "py",
  "ruby",
  "perl",
  "php",
  "bash",
  "sh",
  "zsh",
  "pwsh",
  "powershell",
  "cmd",
]);

const GIT_GLOBAL_DENIED = ["-c", "-C", "--config-env", "--git-dir", "--work-tree", "--exec-path"];
const GIT_GLOBAL_WITH_VALUE: ReadonlySet<string> = new Set(["-c", "-C", "--config-env", "--git-dir", "--work-tree", "--namespace", "--super-prefix"]);
const GIT_ANYWHERE_PREFIXES = [
  "--exec",
  "-O",
  "--open-files-in-pager",
  "--output",
  "--upload-pack",
  "--receive-pack",
  "--no-index",
  "--ext-diff",
];
const GIT_DENIED_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "config",
  "remote",
  "push",
  "fetch",
  "pull",
  "clone",
  "update-ref",
  "submodule",
  "filter-branch",
  "bisect",
  "difftool",
  "mergetool",
  "worktree",
  "credential",
]);

export function hasPathSeparator(token: string): boolean {
  return token.includes("/") || token.includes("\\");
}

export function programName(token: string, platform: NodeJS.Platform): string {
  const base = token.split(/[\\/]/u).pop() ?? token;
  const stripped = base.replace(EXECUTABLE_SUFFIX, "");
  return platform === "win32" ? stripped.toLowerCase() : stripped;
}

function matchesOption(token: string, option: string): boolean {
  return token === option || token.startsWith(`${option}=`) || (option.length === 2 && token.startsWith(option));
}

export function gitHardDenyReason(argv: readonly string[], platform: NodeJS.Platform): string | undefined {
  const [first, ...args] = argv;
  if (first === undefined || programName(first, platform) !== "git") {
    return undefined;
  }
  let index = 0;
  while (index < args.length) {
    const token = args[index] ?? "";
    if (!token.startsWith("-")) {
      break;
    }
    const denied = GIT_GLOBAL_DENIED.find((option) => matchesOption(token, option));
    if (denied !== undefined) {
      return `git option ${denied} is not permitted`;
    }
    index += GIT_GLOBAL_WITH_VALUE.has(token) ? 2 : 1;
  }
  const subcommand = args[index];
  if (subcommand !== undefined && GIT_DENIED_SUBCOMMANDS.has(subcommand.toLowerCase())) {
    return `git ${subcommand} is not permitted`;
  }
  for (const token of args) {
    const denied = GIT_ANYWHERE_PREFIXES.find((prefix) => token.startsWith(prefix));
    if (denied !== undefined) {
      return `git option ${denied} is not permitted`;
    }
  }
  return undefined;
}

export function validateExecRule(rule: ExecRule, platform: NodeJS.Platform): void {
  const [program] = rule.match;
  if (program === undefined) {
    throw new PermissionConfigError("exec rule must name a program");
  }
  if (program === "*") {
    throw new PermissionConfigError("exec rule cannot start with a wildcard");
  }
  rule.match.forEach((token, index) => {
    if (token === "*" && index !== rule.match.length - 1) {
      throw new PermissionConfigError(`exec rule ${JSON.stringify(rule.match)}: '*' is only allowed as the last token`);
    }
  });
  const isPrefix = rule.match[rule.match.length - 1] === "*";
  if (isPrefix && EXACT_ONLY_PROGRAMS.has(programName(program, platform))) {
    throw new PermissionConfigError(
      `exec rule ${JSON.stringify(rule.match)}: ${program} rules must list the exact argv, prefix rules are not allowed`,
    );
  }
}

export function execRuleMatches(rule: ExecRule, argv: readonly string[], platform: NodeJS.Platform): boolean {
  const [ruleProgram, ...ruleArgs] = rule.match;
  const [program, ...args] = argv;
  if (ruleProgram === undefined || program === undefined) {
    return false;
  }
  if (programName(ruleProgram, platform) !== programName(program, platform)) {
    return false;
  }
  const isPrefix = ruleArgs[ruleArgs.length - 1] === "*";
  const fixed = isPrefix ? ruleArgs.slice(0, -1) : ruleArgs;
  if (isPrefix ? args.length < fixed.length : args.length !== fixed.length) {
    return false;
  }
  return fixed.every((token, index) => token === args[index]);
}

export function pathCandidates(argv: readonly string[]): string[] {
  const out = new Set<string>();
  for (const token of argv.slice(1)) {
    if (token.length === 0) {
      continue;
    }
    out.add(token);
    const equals = token.indexOf("=");
    if (equals >= 0 && equals < token.length - 1) {
      out.add(token.slice(equals + 1));
    }
  }
  return [...out];
}
