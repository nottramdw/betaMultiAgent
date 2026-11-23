import { TeamConfigError } from "@betamultiagent/core";
import { processIo, type CliIo } from "./cli-io.js";
import { CliError, EXIT_FAILED, EXIT_OK, EXIT_STOPPED, EXIT_USAGE, errorMessage } from "./cli-error.js";
import { createCommandContext, type CommandContext, type MainOverrides } from "./commands/command-context.js";
import { doctorCommand } from "./commands/doctor.js";
import { evalCommand } from "./commands/eval.js";
import { memoryCommand } from "./commands/memory.js";
import { modelsCommand } from "./commands/models.js";
import { runCommand } from "./commands/run.js";
import { sessionsCommand } from "./commands/sessions.js";
import { taskCommand } from "./commands/task.js";
import { teamCommand } from "./commands/team.js";
import { trustCommand } from "./commands/trust.js";
import { displayValue } from "./output/sanitize.js";
import { createCliRedactor } from "./wiring.js";

declare const __BMA_VERSION__: string | undefined;

export const VERSION = typeof __BMA_VERSION__ === "string" ? __BMA_VERSION__ : "0.0.0-dev";

export const HELP = `bma ${VERSION}: a multi-agent development environment for Claude and Grok models

Usage:
  bma run [--prompt <text> | --prompt-file <file> | <text>] [--model provider:id] [--role <role>] [--json]
  bma team <task> [--task-file <file>] [--accept <criterion>]... [--allow-dirty] [--max-cost <usd>] [--yes-verify]
           [--candidates <n> [--judge <provider>[:<model>]]...] [--json]
  bma team clean <runId> | --all [--delete-branch] [--yes]
  bma task add <goal> [--goal-file <file>] [--title <text>] [--accept <criterion>]... [--after <id>]...
           [--parent <id>] [--ask] [--json]
  bma task [list [--status <status>] | show <id> | cancel <id> | split <id>] [--json]
  bma task run [<id> | --all [--parallel <n>]] [--allow-dirty] [--max-cost <usd>] [--yes-verify | --unattended] [--json]
  bma sessions [list | show <id> | rm <id> | prune [--older-than <days>]] [--json]
  bma memory [list [--status <status>] | approve <id>... | reject <id>... | rm <id>...] [--json]
  bma models [--provider claude|grok] [--json]
  bma doctor [--json]
  bma trust [--revoke]
  bma eval <suite-dir> --provider claude|grok (--estimate | --max-cost <usd>) [--task <id>]...
           [--variant <file>] [--judge <provider>[:<model>]]... [--repeat <n>] [--max-wall-minutes <n>]
           [--out <file>] [--keep] [--json]
  bma eval compare <a.json> <b.json> [--json]
  bma --version | --help

Environment:
  ANTHROPIC_API_KEY, XAI_API_KEY     provider API keys (never stored in configuration files)
  ANTHROPIC_BASE_URL, XAI_BASE_URL   override the API hosts
  BMA_HOME                           single directory for state and configuration

Exit codes: 0 ok, 1 failed, 2 usage or configuration error, 3 budget exceeded,
4 refused, blocked or needs human review, 130 interrupted.
`;

type Command = (context: CommandContext, args: readonly string[]) => Promise<number> | number;

const COMMANDS: Readonly<Record<string, Command>> = {
  run: runCommand,
  team: teamCommand,
  task: taskCommand,
  sessions: sessionsCommand,
  memory: memoryCommand,
  models: modelsCommand,
  doctor: doctorCommand,
  trust: trustCommand,
  eval: (context, args) => evalCommand(context, args, main),
};

const CONSOLE_METHODS = ["log", "info", "debug", "warn", "error", "trace", "dir", "table"] as const;

function redirectConsole(context: CommandContext): () => void {
  const saved = CONSOLE_METHODS.map((name) => [name, Reflect.get(console, name) as unknown] as const);
  for (const name of CONSOLE_METHODS) {
    console[name] = (...items: unknown[]) => {
      context.err.line(items.map((item) => displayValue(item, 100_000)).join(" "));
    };
  }
  return () => {
    for (const [name, method] of saved) {
      Reflect.set(console, name, method);
    }
  };
}

export const AGENT_CHILD_VARIABLE = "BMA_AGENT_CHILD";

function maintenanceAction(name: string, args: readonly string[]): string | undefined {
  const [action] = args;
  if (name === "trust") {
    return "bma trust";
  }
  if (name === "team" && action === "clean") {
    return "bma team clean";
  }
  if (name === "sessions" && (action === "rm" || action === "prune")) {
    return `bma sessions ${action}`;
  }
  if (name === "task" && (action === "cancel" || action === "split")) {
    return `bma task ${action}`;
  }
  if (name === "memory" && (action === "approve" || action === "reject" || action === "rm")) {
    return `bma memory ${action}`;
  }
  return undefined;
}

function wantsJson(args: readonly string[]): boolean {
  return args.includes("--json");
}

function usageFailure(error: unknown): boolean {
  if (error instanceof CliError) {
    return error.exitCode === EXIT_USAGE;
  }
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.startsWith("ERR_PARSE_ARGS");
}

export async function main(argv: readonly string[], io: CliIo, overrides: MainOverrides = {}): Promise<number> {
  const redactor = createCliRedactor(io.env);
  const context = createCommandContext(io, redactor, overrides);
  const [name, ...args] = argv;
  if (name === undefined || name === "--help" || name === "-h" || name === "help") {
    context.out.write(HELP);
    return name === undefined ? EXIT_USAGE : EXIT_OK;
  }
  if (name === "--version" || name === "-v") {
    context.out.line(VERSION);
    return EXIT_OK;
  }
  const command = COMMANDS[name];
  if (command === undefined) {
    context.err.line(`bma: unknown command ${JSON.stringify(name)}; run bma --help`);
    return EXIT_USAGE;
  }
  if (args.includes("--help") || args.includes("-h")) {
    context.out.write(HELP);
    return EXIT_OK;
  }
  const maintenance = io.env[AGENT_CHILD_VARIABLE] === "1" ? maintenanceAction(name, args) : undefined;
  if (maintenance !== undefined) {
    context.err.line(`bma: ${maintenance} is not available to processes started by an agent (${AGENT_CHILD_VARIABLE} is set)`);
    return EXIT_STOPPED;
  }
  const restore = wantsJson(args) ? redirectConsole(context) : undefined;
  try {
    return await command(context, args);
  } catch (error) {
    if (usageFailure(error)) {
      context.err.line(`bma: ${errorMessage(error)}`);
      return EXIT_USAGE;
    }
    if (error instanceof CliError) {
      context.err.line(`bma: ${error.message}`);
      return error.exitCode;
    }
    if (error instanceof TeamConfigError) {
      context.err.line(`bma: ${error.message}`);
      return EXIT_USAGE;
    }
    context.err.line(`bma: ${errorMessage(error)}`);
    return EXIT_FAILED;
  } finally {
    restore?.();
  }
}

export async function runCli(): Promise<void> {
  const io = processIo();
  const code = await main(process.argv.slice(2), io);
  process.exitCode = code;
}
