import { ULID_PATTERN } from "@betamultiagent/core";
import { createRepoOps } from "@betamultiagent/tools";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { EXIT_FAILED, EXIT_OK, errorMessage, usageError } from "../cli-error.js";
import { runsDir, worktreesDir } from "../config/paths.js";
import { displayValue } from "../output/sanitize.js";
import { openWorkspace } from "../wiring.js";
import { confirm, type CommandContext } from "./command-context.js";

async function exists(target: string): Promise<boolean> {
  return stat(target).then(
    () => true,
    () => false,
  );
}

async function listRuns(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => ULID_PATTERN.test(name)).sort();
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function teamCleanCommand(context: CommandContext, args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      all: { type: "boolean", default: false },
      "delete-branch": { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
    },
  });
  if (values.all === positionals.length > 0 || positionals.length > 1) {
    throw usageError("usage: bma team clean <runId> | --all [--delete-branch] [--yes]");
  }
  const workspace = await openWorkspace(context.io, context.redactor);
  const runs = runsDir(workspace.dirs, workspace.root);
  const known = await listRuns(runs);
  const selected = values.all ? known : positionals;
  for (const runId of selected) {
    if (!ULID_PATTERN.test(runId) || !known.includes(runId)) {
      throw usageError(`no team run ${JSON.stringify(runId)} belongs to this workspace`);
    }
  }
  if (selected.length === 0) {
    context.err.line("bma: no team runs to clean");
    return EXIT_OK;
  }
  const worktrees = worktreesDir(workspace.dirs);
  const plan: { runId: string; worktree: string | undefined; changes: readonly string[] }[] = [];
  for (const runId of selected) {
    const hooksDir = path.join(runs, runId, "hooks");
    await mkdir(hooksDir, { recursive: true, mode: 0o700 });
    const worktree = path.join(worktrees, runId);
    if (!(await exists(worktree))) {
      plan.push({ runId, worktree: undefined, changes: [] });
      continue;
    }
    let changes: readonly string[] = [];
    try {
      changes = await createRepoOps({ repoRoot: worktree, hooksDir, worktreesDir: worktrees, baseEnv: context.io.env }).changedPaths("HEAD");
    } catch (error) {
      context.err.line(`bma: cannot list changes in ${worktree}: ${errorMessage(error)}`);
    }
    plan.push({ runId, worktree, changes });
  }
  for (const entry of plan) {
    context.err.line(`${entry.runId}: ${entry.worktree === undefined ? "no worktree" : `worktree ${entry.worktree}`}`);
    if (entry.changes.length > 0) {
      context.err.line(`  ${String(entry.changes.length)} uncommitted change(s) will be lost:`);
      for (const file of entry.changes.slice(0, 20)) {
        context.err.line(`    ${displayValue(file)}`);
      }
    }
    if (values["delete-branch"]) {
      context.err.line(`  branch bma/${entry.runId} will be deleted`);
    }
  }
  if (!values.yes) {
    if (!(context.io.stdinIsTTY && context.io.stderr.isTTY)) {
      throw usageError("refusing to clean without confirmation; pass --yes when not running in a terminal");
    }
    if (!(await confirm(context, `remove ${String(plan.length)} team run(s)? [y/N]: `))) {
      context.err.line("bma: nothing removed");
      return EXIT_OK;
    }
  }
  let failed = false;
  for (const entry of plan) {
    const repo = createRepoOps({ repoRoot: workspace.root, hooksDir: path.join(runs, entry.runId, "hooks"), worktreesDir: worktrees, baseEnv: context.io.env });
    try {
      if (entry.worktree !== undefined) {
        await repo.removeWorktree(entry.worktree, { force: true });
      }
      if (values["delete-branch"]) {
        await repo.deleteBranch(`bma/${entry.runId}`);
      }
      await rm(path.join(runs, entry.runId), { recursive: true, force: true });
      context.err.line(`bma: removed ${entry.runId}`);
    } catch (error) {
      failed = true;
      context.err.line(`bma: failed to clean ${entry.runId}: ${errorMessage(error)}`);
    }
  }
  return failed ? EXIT_FAILED : EXIT_OK;
}
