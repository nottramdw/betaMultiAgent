import { PROJECT_CONTEXT_FILES } from "@betamultiagent/core";
import { spawnSync } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { EXIT_FAILED, EXIT_OK, errorMessage } from "../cli-error.js";
import { isInsideOrEqual, realpathLoose, resolveDirs, type BmaDirs } from "../config/paths.js";
import { JsonlWriter } from "../output/jsonl.js";
import { loadSkills, openWorkspace, type Workspace } from "../wiring.js";
import type { CommandContext } from "./command-context.js";

type Level = "ok" | "info" | "warn" | "error";

interface Check {
  readonly name: string;
  readonly level: Level;
  readonly detail: string;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

function gitVersion(): Check {
  const result = spawnSync("git", ["--version"], { encoding: "utf8", timeout: 5000, windowsHide: true });
  if (result.error !== undefined || result.status !== 0) {
    return { name: "git", level: "warn", detail: "git was not found; bma team needs git" };
  }
  return { name: "git", level: "ok", detail: result.stdout.trim() };
}

function headerNames(raw: string | undefined): string[] {
  if (raw === undefined) {
    return [];
  }
  return raw
    .split(/\r?\n/u)
    .map((line) => line.split(":")[0]?.trim() ?? "")
    .filter((name) => name.length > 0);
}

function longPaths(platform: NodeJS.Platform): Check | undefined {
  if (platform !== "win32") {
    return undefined;
  }
  const result = spawnSync("reg", ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem", "/v", "LongPathsEnabled"], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
  const enabled = result.status === 0 && /LongPathsEnabled\s+REG_DWORD\s+0x1\b/u.test(result.stdout);
  return enabled
    ? { name: "long paths", level: "ok", detail: "Windows long path support is enabled" }
    : {
        name: "long paths",
        level: "warn",
        detail: "Windows long path support appears disabled; deep worktree paths may fail (enable LongPathsEnabled and git config core.longpaths true)",
      };
}

async function stateDirCheck(dirs: BmaDirs, platform: NodeJS.Platform): Promise<Check> {
  try {
    const info = await stat(dirs.state);
    if (!info.isDirectory()) {
      return { name: "state dir", level: "error", detail: `${dirs.state} exists but is not a directory` };
    }
    if (platform !== "win32" && (info.mode & 0o077) !== 0) {
      return { name: "state dir", level: "warn", detail: `${dirs.state} is accessible by other users (mode ${(info.mode & 0o777).toString(8)}); run chmod 700` };
    }
    return { name: "state dir", level: "ok", detail: dirs.state };
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { name: "state dir", level: "info", detail: `${dirs.state} (created on first run)` };
    }
    return { name: "state dir", level: "error", detail: `${dirs.state}: ${errorMessage(error)}` };
  }
}

async function workspaceChecks(context: CommandContext): Promise<Check[]> {
  let workspace: Workspace;
  try {
    workspace = await openWorkspace(context.io, context.redactor);
  } catch (error) {
    return [{ name: "workspace", level: "error", detail: errorMessage(error) }];
  }
  const checks: Check[] = [
    { name: "workspace", level: "ok", detail: workspace.root },
    {
      name: "trust",
      level: workspace.trusted ? "ok" : "info",
      detail: workspace.trusted ? "trusted" : "not trusted; project settings other than deny/ask rules are ignored (bma trust)",
    },
    {
      name: "project config",
      level: "ok",
      detail: workspace.projectConfig.exists ? `${workspace.projectConfig.file} is valid` : "no bma.config.json",
    },
    {
      name: "user config",
      level: "ok",
      detail: workspace.userConfig.exists ? `${workspace.userConfig.file} is valid` : `no ${workspace.userConfig.file}`,
    },
  ];
  for (const warning of workspace.config.warnings) {
    checks.push({ name: "config", level: "warn", detail: warning });
  }
  const instructions: string[] = [];
  for (const name of PROJECT_CONTEXT_FILES) {
    if (await stat(path.join(workspace.root, name)).then((info) => info.isFile(), () => false)) {
      instructions.push(name);
    }
  }
  checks.push({
    name: "instructions",
    level: "info",
    detail:
      instructions.length === 0
        ? "no AGENTS.md or CLAUDE.md"
        : `${instructions.join(", ")}${workspace.trusted ? "" : " (ignored until the workspace is trusted)"}`,
  });
  const skills = await loadSkills(workspace);
  checks.push({ name: "skills", level: "info", detail: `${String(skills.skills.length)} skill(s), ${String(skills.plugins.length)} plugin(s)` });
  for (const warning of skills.warnings) {
    checks.push({ name: "skills", level: "warn", detail: warning });
  }
  return checks;
}

export async function doctorCommand(context: CommandContext, args: readonly string[]): Promise<number> {
  const { values } = parseArgs({ args: [...args], strict: true, options: { json: { type: "boolean", default: false } } });
  const { env, platform, homedir } = context.io;
  const dirs = resolveDirs(env, platform, homedir);
  const checks: Check[] = [
    { name: "node", level: "ok", detail: process.version },
    { name: "platform", level: "ok", detail: `${platform} ${process.arch}` },
    gitVersion(),
    {
      name: "keys",
      level: nonEmpty(env["ANTHROPIC_API_KEY"]) === undefined && nonEmpty(env["XAI_API_KEY"]) === undefined ? "warn" : "ok",
      detail: `ANTHROPIC_API_KEY ${String(nonEmpty(env["ANTHROPIC_API_KEY"]) !== undefined)}, ANTHROPIC_AUTH_TOKEN ${String(nonEmpty(env["ANTHROPIC_AUTH_TOKEN"]) !== undefined)} (not used for requests), XAI_API_KEY ${String(nonEmpty(env["XAI_API_KEY"]) !== undefined)}`,
    },
    {
      name: "hosts",
      level: "info",
      detail: `claude ${nonEmpty(env["ANTHROPIC_BASE_URL"]) ?? "https://api.anthropic.com"}, grok ${nonEmpty(env["XAI_BASE_URL"]) ?? "https://api.x.ai/v1"}`,
    },
  ];
  const headers = headerNames(nonEmpty(env["ANTHROPIC_CUSTOM_HEADERS"]));
  if (headers.length > 0) {
    checks.push({ name: "custom headers", level: "info", detail: `ANTHROPIC_CUSTOM_HEADERS names: ${headers.join(", ")}` });
  }
  if (nonEmpty(env["XAI_DEBUG"]) !== undefined) {
    checks.push({ name: "debug", level: "warn", detail: "XAI_DEBUG is set; SDK debug logs may include request details" });
  }
  checks.push(await stateDirCheck(dirs, platform));
  checks.push({ name: "config dir", level: "info", detail: dirs.config });
  if (dirs.bmaHome !== undefined && !isInsideOrEqual(realpathLoose(homedir), realpathLoose(dirs.bmaHome), platform)) {
    checks.push({ name: "BMA_HOME", level: "warn", detail: `${dirs.bmaHome} is outside the user profile; other users may be able to read sessions` });
  }
  checks.push(...(await workspaceChecks(context)));
  const long = longPaths(platform);
  if (long !== undefined) {
    checks.push(long);
  }
  checks.push(
    { name: "sandbox", level: "info", detail: "commands run with your user permissions; there is no OS sandbox, only the permission policy" },
    { name: "keys advice", level: "info", detail: "use API keys with spend limits for agent work" },
  );
  const failed = checks.some((check) => check.level === "error");
  if (values.json) {
    new JsonlWriter(context.io.stdout, context.redactor).writeResult("doctor", { ok: !failed, checks });
  } else {
    for (const check of checks) {
      context.out.line(`[${check.level}] ${check.name}: ${check.detail}`);
    }
  }
  return failed ? EXIT_FAILED : EXIT_OK;
}
