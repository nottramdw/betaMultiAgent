import { MAX_ACCEPTANCE_CRITERIA, MAX_CRITERION_LENGTH, type Redactor } from "@betamultiagent/core";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const TASK_EVENT_VERSION = 1;
export const TASK_FILE = "tasks.jsonl";
export const MAX_TITLE_LENGTH = 200;
export const MAX_GOAL_LENGTH = 20_000;
export const MAX_DEPENDENCIES = 32;
export const MIN_ID_PREFIX = 4;

export const TaskStatusSchema = z.enum(["open", "running", "done", "failed", "needs-human", "cancelled"]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskModeSchema = z.enum(["team", "ask"]);
export type TaskMode = z.infer<typeof TaskModeSchema>;

const TaskSpecSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(MAX_TITLE_LENGTH),
  goal: z.string().min(1).max(MAX_GOAL_LENGTH),
  mode: TaskModeSchema,
  acceptance: z.array(z.string().min(1).max(MAX_CRITERION_LENGTH)).max(MAX_ACCEPTANCE_CRITERIA),
  dependencies: z.array(z.string().min(1)).max(MAX_DEPENDENCIES),
  parent: z.string().min(1).optional(),
  createdAt: z.iso.datetime(),
});
export type TaskSpec = z.infer<typeof TaskSpecSchema>;

const AddedEventSchema = z.object({ type: z.literal("added"), task: TaskSpecSchema });

const StatusEventSchema = z.object({
  type: z.literal("status"),
  id: z.string().min(1),
  status: TaskStatusSchema,
  runId: z.string().min(1).optional(),
  code: z.string().min(1).optional(),
  message: z.string().optional(),
});
export type TaskStatusChange = Omit<z.infer<typeof StatusEventSchema>, "type">;

const TaskEventSchema = z.intersection(
  z.object({ v: z.literal(TASK_EVENT_VERSION), ts: z.iso.datetime() }),
  z.discriminatedUnion("type", [AddedEventSchema, StatusEventSchema]),
);
type TaskEvent = z.infer<typeof TaskEventSchema>;

export interface TaskHistoryEntry {
  readonly ts: string;
  readonly status: TaskStatus;
  readonly runId?: string;
  readonly code?: string;
  readonly message?: string;
}

export interface TaskState extends TaskSpec {
  readonly status: TaskStatus;
  readonly updatedAt: string;
  readonly history: readonly TaskHistoryEntry[];
}

export type TaskWarn = (message: string) => void;

export class TaskLookupError extends Error {}

function fold(events: readonly TaskEvent[], warn: TaskWarn): TaskState[] {
  const tasks = new Map<string, TaskState>();
  for (const event of events) {
    if (event.type === "added") {
      if (tasks.has(event.task.id)) {
        warn(`duplicate task ${event.task.id} ignored`);
        continue;
      }
      tasks.set(event.task.id, { ...event.task, status: "open", updatedAt: event.ts, history: [] });
      continue;
    }
    const current = tasks.get(event.id);
    if (current === undefined) {
      warn(`status for unknown task ${event.id} ignored`);
      continue;
    }
    const entry: TaskHistoryEntry = {
      ts: event.ts,
      status: event.status,
      ...(event.runId === undefined ? {} : { runId: event.runId }),
      ...(event.code === undefined ? {} : { code: event.code }),
      ...(event.message === undefined ? {} : { message: event.message }),
    };
    tasks.set(event.id, { ...current, status: event.status, updatedAt: event.ts, history: [...current.history, entry] });
  }
  return [...tasks.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export class TaskStore {
  readonly dir: string;
  readonly #redactor: Redactor;
  readonly #now: () => Date;
  readonly #warn: TaskWarn;

  constructor(dir: string, redactor: Redactor, now: () => Date, warn: TaskWarn) {
    this.dir = dir;
    this.#redactor = redactor;
    this.#now = now;
    this.#warn = warn;
  }

  get file(): string {
    return path.join(this.dir, TASK_FILE);
  }

  async load(): Promise<TaskState[]> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const events: TaskEvent[] = [];
    for (const [index, line] of text.split("\n").entries()) {
      if (line.trim().length === 0) {
        continue;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        this.#warn(`${TASK_FILE}:${String(index + 1)}: skipped unparsable task event`);
        continue;
      }
      const parsed = TaskEventSchema.safeParse(raw);
      if (parsed.success) {
        events.push(parsed.data);
      } else {
        this.#warn(`${TASK_FILE}:${String(index + 1)}: skipped invalid task event`);
      }
    }
    return fold(events, this.#warn);
  }

  async add(task: TaskSpec): Promise<TaskSpec> {
    const event = TaskEventSchema.parse(
      this.#redactor.redactValue({ v: TASK_EVENT_VERSION, ts: this.#now().toISOString(), type: "added", task }),
    );
    await this.#append(event);
    return (event as z.infer<typeof AddedEventSchema>).task;
  }

  async setStatus(change: TaskStatusChange): Promise<void> {
    const event = TaskEventSchema.parse(
      this.#redactor.redactValue({ v: TASK_EVENT_VERSION, ts: this.#now().toISOString(), type: "status", ...change }),
    );
    await this.#append(event);
  }

  async #append(event: TaskEvent): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await appendFile(this.file, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  }
}

export function findTask(tasks: readonly TaskState[], reference: string): TaskState {
  const exact = tasks.find((task) => task.id === reference);
  if (exact !== undefined) {
    return exact;
  }
  const needle = reference.toUpperCase();
  if (needle.length < MIN_ID_PREFIX) {
    throw new TaskLookupError(`task id ${JSON.stringify(reference)} is too short; give at least ${String(MIN_ID_PREFIX)} characters`);
  }
  const matches = tasks.filter((task) => task.id.startsWith(needle));
  if (matches.length === 1 && matches[0] !== undefined) {
    return matches[0];
  }
  throw new TaskLookupError(
    matches.length === 0 ? `no task matches ${JSON.stringify(reference)}` : `task id ${JSON.stringify(reference)} is ambiguous`,
  );
}

export function isReady(task: TaskState, tasks: readonly TaskState[]): boolean {
  return dependenciesDone(task, tasks) && task.status === "open";
}

export function dependenciesDone(task: TaskState, tasks: readonly TaskState[]): boolean {
  return task.dependencies.every((id) => tasks.find((candidate) => candidate.id === id)?.status === "done");
}
