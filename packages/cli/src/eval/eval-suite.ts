import { TEAM_ROLES, type AgentRole } from "@betamultiagent/core";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { usageError } from "../cli-error.js";

const SLUG = /^[a-z0-9][a-z0-9-]*$/u;
export const MAX_CRITERION_CHARS = 500;

export const EvalTaskKindSchema = z.enum(["normal", "hard-to-verify", "trap"]);
export type EvalTaskKind = z.infer<typeof EvalTaskKindSchema>;

const turnCount = z.number().int().nonnegative().optional();

export const EvalTaskSchema = z.strictObject({
  id: z.string().regex(SLUG),
  kind: EvalTaskKindSchema,
  fixture: z.string().regex(SLUG),
  task: z.string().min(1),
  accept: z.array(z.string().min(1).max(MAX_CRITERION_CHARS)).default([]),
  expect: z.enum(["approved", "not-approved"]),
  check: z.string().regex(/^[a-z0-9][a-z0-9-]*\.js$/u).optional(),
  turns: z.strictObject({ lead: turnCount, researcher: turnCount, executor: turnCount, reviewer: turnCount }).optional(),
});
export type EvalTask = z.infer<typeof EvalTaskSchema>;

export interface EvalSuite {
  readonly dir: string;
  readonly fixturesDir: string;
  readonly tasks: readonly EvalTask[];
}

async function isDirectory(target: string): Promise<boolean> {
  return stat(target).then(
    (info) => info.isDirectory(),
    () => false,
  );
}

async function isFile(target: string): Promise<boolean> {
  return stat(target).then(
    (info) => info.isFile(),
    () => false,
  );
}

function issues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
}

export async function loadEvalSuite(dir: string): Promise<EvalSuite> {
  const tasksDir = path.join(dir, "tasks");
  const fixturesDir = path.join(dir, "fixtures");
  if (!(await isDirectory(tasksDir)) || !(await isDirectory(fixturesDir))) {
    throw usageError(`${dir}: an eval suite needs tasks/ and fixtures/ directories`);
  }
  const files = (await readdir(tasksDir)).filter((name) => name.endsWith(".json")).sort();
  if (files.length === 0) {
    throw usageError(`${tasksDir}: no task files`);
  }
  const tasks: EvalTask[] = [];
  for (const file of files) {
    const location = path.join(tasksDir, file);
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(location, "utf8"));
    } catch (error) {
      throw usageError(`${location}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
    }
    const parsed = EvalTaskSchema.safeParse(raw);
    if (!parsed.success) {
      throw usageError(`${location}: ${issues(parsed.error)}`);
    }
    if (tasks.some((task) => task.id === parsed.data.id)) {
      throw usageError(`${location}: duplicate task id ${parsed.data.id}`);
    }
    if (!(await isDirectory(path.join(fixturesDir, parsed.data.fixture)))) {
      throw usageError(`${location}: fixture ${parsed.data.fixture} does not exist`);
    }
    if (parsed.data.check !== undefined && !(await isFile(path.join(dir, "checks", parsed.data.check)))) {
      throw usageError(`${location}: check ${parsed.data.check} does not exist in checks/`);
    }
    tasks.push(parsed.data);
  }
  return { dir, fixturesDir, tasks };
}

export function selectTasks(suite: EvalSuite, ids: readonly string[]): readonly EvalTask[] {
  if (ids.length === 0) {
    return suite.tasks;
  }
  for (const id of ids) {
    if (!suite.tasks.some((task) => task.id === id)) {
      throw usageError(`unknown task ${JSON.stringify(id)}`);
    }
  }
  return suite.tasks.filter((task) => ids.includes(task.id));
}

export function taskTurns(task: EvalTask, defaults: Readonly<Record<AgentRole, number>>): Record<AgentRole, number> {
  const turns = { ...defaults };
  for (const role of TEAM_ROLES) {
    const value = task.turns?.[role];
    if (value !== undefined) {
      turns[role] = value;
    }
  }
  return turns;
}
