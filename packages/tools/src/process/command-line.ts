import path from "node:path";
import { ExecError } from "./exec-error.js";

export const WINDOWS_COMMAND_LINE_LIMIT = 32_767;
export const WINDOWS_CMD_LINE_LIMIT = 8_191;

const CMD_SAFE_ARGUMENT = /^[A-Za-z0-9_\-+=.,:/\\@]+$/u;
const CMD_UNSAFE_PATH_CHARS = /["%^&|<>!]/u;
const CMD_ADVICE = "call the underlying program directly instead, for example `node <script>`";

export interface SpawnPlan {
  readonly file: string;
  readonly args: readonly string[];
  readonly verbatimArguments: boolean;
  readonly viaCmd: boolean;
}

export function isCmdShim(file: string): boolean {
  return /\.(?:cmd|bat)$/iu.test(file);
}

export function commandLineLength(file: string, args: readonly string[]): number {
  return [file, ...args].reduce((total, token) => total + token.length + 3 + (token.match(/"/gu)?.length ?? 0), 0);
}

export function assertCommandLineFits(plan: SpawnPlan, platform: NodeJS.Platform, cmdLine?: string): void {
  if (platform !== "win32") {
    return;
  }
  if (plan.viaCmd && cmdLine !== undefined && cmdLine.length + 2 > WINDOWS_CMD_LINE_LIMIT) {
    throw new ExecError(
      "command-too-long",
      `command line is ${String(cmdLine.length)} characters; the limit through cmd.exe (.cmd/.bat) is ${String(WINDOWS_CMD_LINE_LIMIT)}`,
    );
  }
  const length = commandLineLength(plan.file, plan.args);
  if (length > WINDOWS_COMMAND_LINE_LIMIT) {
    throw new ExecError(
      "command-too-long",
      `command line is about ${String(length)} characters; the Windows limit is ${String(WINDOWS_COMMAND_LINE_LIMIT)}`,
    );
  }
}

export function buildCmdLine(shim: string, args: readonly string[]): string {
  if (CMD_UNSAFE_PATH_CHARS.test(shim)) {
    throw new ExecError("command-rejected", `shim path contains characters that cmd.exe would interpret: ${shim}; ${CMD_ADVICE}`);
  }
  for (const arg of args) {
    if (arg.length === 0) {
      throw new ExecError("command-rejected", `empty arguments are not allowed for .cmd/.bat shims; ${CMD_ADVICE}`);
    }
    if (!CMD_SAFE_ARGUMENT.test(arg)) {
      throw new ExecError(
        "command-rejected",
        `argument ${JSON.stringify(arg)} contains characters not allowed for .cmd/.bat shims (allowed: A-Z a-z 0-9 _ - + = . , : / \\ @); ${CMD_ADVICE}`,
      );
    }
  }
  return [`"${shim}"`, ...args].join(" ");
}

export function planSpawn(file: string, args: readonly string[], platform: NodeJS.Platform, systemRoot: string): SpawnPlan {
  if (platform === "win32" && isCmdShim(file)) {
    const line = buildCmdLine(file, args);
    const plan: SpawnPlan = {
      file: path.win32.join(systemRoot, "System32", "cmd.exe"),
      args: ["/d", "/s", "/c", `"${line}"`],
      verbatimArguments: true,
      viaCmd: true,
    };
    assertCommandLineFits(plan, platform, line);
    return plan;
  }
  const plan: SpawnPlan = { file, args, verbatimArguments: false, viaCmd: false };
  assertCommandLineFits(plan, platform);
  return plan;
}
