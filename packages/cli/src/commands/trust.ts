import { PROJECT_CONTEXT_FILES } from "@betamultiagent/core";
import { discoverSkills } from "@betamultiagent/skills";
import { stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { EXIT_OK, usageError } from "../cli-error.js";
import { grantTrust, revokeTrust } from "../config/trust.js";
import { displayValue } from "../output/sanitize.js";
import { ensureStateDir, openWorkspace, type Workspace } from "../wiring.js";
import { confirm, type CommandContext } from "./command-context.js";

async function presentFiles(root: string, names: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  for (const name of names) {
    if (await stat(path.join(root, name)).then((info) => info.isFile(), () => false)) {
      found.push(name);
    }
  }
  return found;
}

async function describeActivation(workspace: Workspace): Promise<string[]> {
  const project = workspace.projectConfig.config;
  const rules = project.permissions?.rules ?? [];
  const lines = [`Trusting ${workspace.root} activates:`];
  const allow = rules.filter((rule) => rule.decision === "allow");
  const ask = rules.filter((rule) => rule.decision === "ask");
  lines.push(`  allow rules: ${displayValue(allow, 2000)}`);
  lines.push(`  ask rules: ${displayValue(ask, 2000)}`);
  lines.push(`  team.setup commands: ${displayValue(project.team?.setup ?? [], 2000)}`);
  lines.push(`  env.passthrough: ${displayValue(project.env?.passthrough ?? [], 1000)}`);
  lines.push(`  budget: ${displayValue(project.budget ?? {}, 500)}`);
  lines.push(`  roles: ${displayValue(project.roles ?? {}, 2000)}`);
  const instructions = await presentFiles(workspace.root, PROJECT_CONTEXT_FILES);
  lines.push(`  instruction files: ${instructions.length === 0 ? "none" : instructions.join(", ")}`);
  const skills = await discoverSkills({ root: workspace.root, userConfigDir: workspace.dirs.config, trusted: true });
  const repoSkills = skills.skills.filter((skill) => skill.source === "repo").map((skill) => skill.name);
  lines.push(`  repository skills: ${repoSkills.length === 0 ? "none" : displayValue(repoSkills.join(", "), 1000)}`);
  lines.push("  verification and setup commands proposed by agents may be approved and run");
  lines.push(`Trust is bound to the current content of bma.config.json (sha256 ${workspace.digest.slice(0, 16)}...); editing it revokes trust.`);
  return lines;
}

export async function trustCommand(context: CommandContext, args: readonly string[]): Promise<number> {
  const { values } = parseArgs({ args: [...args], strict: true, options: { revoke: { type: "boolean", default: false } } });
  const workspace = await openWorkspace(context.io, context.redactor);
  if (values.revoke) {
    const removed = await revokeTrust(workspace.dirs, workspace.root);
    context.err.line(removed ? `bma: trust revoked for ${workspace.root}` : `bma: ${workspace.root} was not trusted`);
    return EXIT_OK;
  }
  for (const line of await describeActivation(workspace)) {
    context.err.line(line);
  }
  if (workspace.trusted) {
    context.err.line("bma: this workspace is already trusted");
    return EXIT_OK;
  }
  if (!(context.io.stdinIsTTY && context.io.stderr.isTTY)) {
    throw usageError("bma trust needs an interactive terminal to confirm; nothing was changed");
  }
  if (!(await confirm(context, "trust this workspace? [y/N]: "))) {
    context.err.line("bma: not trusted");
    return EXIT_OK;
  }
  await ensureStateDir(workspace.dirs);
  await grantTrust(workspace.dirs, workspace.root, workspace.digest, context.io.now());
  context.err.line(`bma: trusted ${workspace.root}`);
  return EXIT_OK;
}
