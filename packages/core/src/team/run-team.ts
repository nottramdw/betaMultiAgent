import type { z } from "zod";
import type { AgentRole, ModelRef, TurnOutcome } from "../agent/agent-spec.js";
import { AgentSession } from "../agent/run-session.js";
import { buildSystemPrompt, loadProjectContext, type ProjectContext } from "../agent/system-prompt.js";
import type { PermissionGate } from "../agent/tool-execution.js";
import { ChangesetTooLargeError, type Environment, type EnvironmentFactory, type RepoOps } from "../environment/environment.js";
import { InMemoryEventSink, type EventListener, type EventRecord, type EventSink } from "../events/events.js";
import { ulid } from "../ids/ulid.js";
import type { StopDetails } from "../messages/messages.js";
import type { ModelInfo, Provider } from "../provider/provider.js";
import type { Redactor } from "../redaction/redaction.js";
import type { ToolDefinition } from "../tools/tool-definition.js";
import { UsageLedger, type UsageTotals } from "../usage/usage.js";
import {
  createSubmitPlanTool,
  createSubmitResultTool,
  createSubmitReviewTool,
  TeamPlanSchema,
  TeamResultSchema,
  TeamReviewSchema,
  type TeamCommand,
  type TeamPlan,
  type TeamResult,
  type TeamReview,
} from "./completion-tools.js";
import { createDelegateTool, type DelegateReport, type DelegateTask } from "./delegate-tool.js";
import {
  executorHandoff,
  leadHandoff,
  planCorrection,
  researchHandoff,
  reviewerHandoff,
  reviewFeedback,
  scopeFeedback,
  verificationFeedback,
  type ReviewDiff,
  type VerificationStatus,
  type VerificationSummary,
} from "./handoff.js";
import { RESERVED_TEAM_TOOLS, roleSpec, type TeamRoles } from "./roles.js";
import { classifyChanges, scopeProblems, toRelativePosix } from "./scope-check.js";
import {
  approveCommands,
  evaluateCommands,
  runCommands,
  type CommandApproval,
  type CommandApprover,
  type CommandPolicy,
  type CommandRun,
} from "./verification-gate.js";

export const MAX_REVISIONS = 2;
export const MAX_PLAN_CORRECTIONS = 2;
export const MAX_REVIEW_DIFF_BYTES = 200 * 1024;
export const MAX_IGNORED_PATHS = 200;

export type TeamStatus = "approved" | "needs-human" | "blocked" | "failed" | "budget-exceeded" | "aborted";

export interface TeamSessionSummary {
  readonly id: string;
  readonly role: AgentRole;
  readonly provider: string;
  readonly model: string;
  readonly outcome?: TurnOutcome["type"];
}

export interface TeamOutcome {
  readonly runId: string;
  readonly status: TeamStatus;
  readonly code?: string;
  readonly message?: string;
  readonly stopDetails?: StopDetails;
  readonly verification: VerificationStatus;
  readonly verificationRuns: readonly CommandRun[];
  readonly unapprovedCommands: readonly TeamCommand[];
  readonly sensitiveChanges: readonly string[];
  readonly ignoredPaths: readonly string[];
  readonly branch?: string;
  readonly worktreePath?: string;
  readonly baseCommit?: string;
  readonly commit?: string;
  readonly commitError?: string;
  readonly plan?: TeamPlan;
  readonly review?: TeamReview;
  readonly revisions: number;
  readonly planCorrections?: number;
  readonly sessions: readonly TeamSessionSummary[];
  readonly usage: UsageTotals;
  readonly usageByRole?: Partial<Record<AgentRole, UsageTotals>>;
}

export interface ResolvedModel {
  readonly provider: Provider;
  readonly model: ModelInfo;
}

export type ModelResolver = (ref: ModelRef) => ResolvedModel;
export type RoleToolFactory = (role: AgentRole, environment: Environment) => readonly ToolDefinition[];
export type RolePermissionFactory = (role: AgentRole, environment: Environment) => PermissionGate;

export interface TeamSessionLog extends EventSink {
  close?(): Promise<void>;
}

export interface TeamBudget {
  readonly maxCostUsd?: number;
  readonly maxWallMs?: number;
}

export interface RunTeamOptions {
  readonly runId?: string;
  readonly root: string;
  readonly trusted: boolean;
  readonly allowDirty?: boolean;
  readonly roles: TeamRoles;
  readonly repo: RepoOps;
  readonly openRepo: (root: string) => RepoOps;
  readonly environments: EnvironmentFactory;
  readonly resolveModel: ModelResolver;
  readonly toolsFor: RoleToolFactory;
  readonly permissionsFor: RolePermissionFactory;
  readonly commandPolicy: CommandPolicy;
  readonly approveCommands?: CommandApprover;
  readonly setup?: readonly TeamCommand[];
  readonly budget?: TeamBudget;
  readonly events: EventSink;
  readonly openSessionLog?: (sessionId: string, role: AgentRole) => Promise<TeamSessionLog>;
  readonly redactor: Redactor;
  readonly skillCatalog?: string;
  readonly listeners?: readonly EventListener[];
  readonly maxRevisions?: number;
  readonly platform?: NodeJS.Platform;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
}

class RunStop extends Error {
  readonly status: Exclude<TeamStatus, "approved">;
  readonly code: string;
  readonly stopDetails: StopDetails | undefined;

  constructor(status: Exclude<TeamStatus, "approved">, code: string, message: string, stopDetails?: StopDetails) {
    super(message);
    this.name = "RunStop";
    this.status = status;
    this.code = code;
    this.stopDetails = stopDetails;
  }
}

type Completed = Extract<TurnOutcome, { type: "completed" }>;
type Stopped = Exclude<TurnOutcome, { type: "completed" }>;

interface SessionEntry {
  readonly id: string;
  readonly role: AgentRole;
  readonly provider: string;
  readonly model: string;
  outcome?: TurnOutcome["type"];
}

interface Changes {
  readonly sensitive: readonly string[];
  readonly outOfScope: readonly string[];
}

const COMPLETION_TOOLS: Readonly<Record<AgentRole, () => ToolDefinition>> = {
  lead: createSubmitPlanTool,
  researcher: createSubmitResultTool,
  executor: createSubmitResultTool,
  reviewer: createSubmitReviewTool,
};

const SKIPPED: VerificationSummary = { status: "skipped", runs: [], unapproved: [] };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unique(items: readonly string[]): string[] {
  return [...new Set(items)].sort();
}

function argvText(command: TeamCommand): string {
  return JSON.stringify(command.argv);
}

function commitMessage(title: string): string {
  return `bma: ${title.replace(/\s+/gu, " ").trim()}`;
}

function describeStopped(outcome: Stopped): string {
  switch (outcome.type) {
    case "refused":
      return "the researcher refused the task";
    case "budget-exceeded":
      return `the researcher exceeded its ${outcome.budget} budget`;
    case "aborted":
      return "the research was aborted";
    case "loop-detected":
      return `the researcher repeated \`${outcome.tool}\` without progress`;
    case "max-tokens":
      return "the researcher hit the output token limit";
    case "failed":
      return `the research failed: ${outcome.message}`;
  }
}

function recordWrites(gate: PermissionGate, environment: Environment, writes: Set<string>): PermissionGate {
  return {
    authorize: async (request) => {
      const outcome = await gate.authorize(request);
      if (outcome.allowed && request.kind === "write") {
        for (const target of request.paths) {
          try {
            const resolved = await environment.resolvePath(target, "write");
            const relative = toRelativePosix(environment.root, resolved.requested);
            if (relative !== undefined) {
              writes.add(relative);
            }
          } catch {
            continue;
          }
        }
      }
      return outcome;
    },
    isPathDenied: (target, mode) => gate.isPathDenied(target, mode),
  };
}

class TeamRun {
  readonly #task: string;
  readonly #options: RunTeamOptions;
  readonly #runId: string;
  readonly #now: () => Date;
  readonly #controller = new AbortController();
  readonly #ledger = new UsageLedger("team");
  readonly #roleLedgers = new Map<AgentRole, UsageLedger>();
  readonly #sessions: SessionEntry[] = [];
  readonly #logs: TeamSessionLog[] = [];
  readonly #writes = new Set<string>();
  readonly #unapproved: TeamCommand[] = [];
  readonly #budgetListener: EventListener;
  #exceeded: "cost" | "wall" | undefined;
  #context: ProjectContext | undefined;
  #mainEnvironment: Environment | undefined;
  #baseCommit: string | undefined;
  #branch: string | undefined;
  #worktreePath: string | undefined;
  #worktreeRepo: RepoOps | undefined;
  #setupBaseline = new Set<string>();
  #ignoredPaths: string[] = [];
  #sensitiveChanges: string[] = [];
  #verification: VerificationSummary = SKIPPED;
  #plan: TeamPlan | undefined;
  #review: TeamReview | undefined;
  #revisions = 0;
  #planCorrections = 0;
  #commit: string | undefined;
  #commitError: string | undefined;
  #integrityFailed = false;

  constructor(task: string, options: RunTeamOptions) {
    this.#task = task;
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
    this.#runId = options.runId ?? ulid(this.#now().getTime());
    this.#budgetListener = {
      onRecord: (record: EventRecord) => {
        if (record.type === "usage") {
          this.#checkCost();
        }
      },
    };
  }

  async execute(): Promise<TeamOutcome> {
    const detach = this.#attachSignals();
    try {
      await this.#flow();
      return await this.#finish("approved");
    } catch (error) {
      const stop = this.#toStop(error);
      await this.#refreshIgnoredQuietly();
      return await this.#finish(stop.status, stop);
    } finally {
      detach();
      for (const log of this.#logs) {
        await log.close?.().catch(() => undefined);
      }
    }
  }

  async #flow(): Promise<void> {
    const options = this.#options;
    await this.#phase("preflight");
    const preflight = await this.#mainGit(() => options.repo.preflight());
    const base = preflight.baseCommit;
    this.#baseCommit = base;
    if (options.allowDirty !== true) {
      const dirty = await this.#mainGit(() => options.repo.changedPaths(base));
      if (dirty.length > 0) {
        throw new RunStop(
          "failed",
          "dirty-tree",
          `the working tree has ${String(dirty.length)} uncommitted change(s); commit or stash them, or allow a dirty tree (uncommitted changes are not copied into the worktree)`,
        );
      }
    }
    this.#context = await loadProjectContext({
      root: options.root,
      trusted: options.trusted,
      ...(options.skillCatalog === undefined ? {} : { skillCatalog: options.skillCatalog }),
    });
    this.#mainEnvironment = await options.environments.create(options.root);

    await this.#phase("plan");
    const { plan, verify } = await this.#makePlan(this.#mainEnvironment);
    this.#plan = plan;
    const setup = await this.#approveSetup();

    this.#checkpoint();
    await this.#phase("worktree");
    const worktree = await this.#mainGit(() => options.repo.addWorktree(this.#runId, base));
    this.#branch = worktree.branch;
    this.#worktreePath = worktree.path;
    this.#worktreeRepo = options.openRepo(worktree.path);
    const environment = await options.environments.create(worktree.path);
    await this.#runSetup(environment, setup);
    this.#setupBaseline = new Set(await this.#worktreeGit((repo) => repo.listIgnored()));

    await this.#phase("execute");
    const executor = await this.#session("executor", environment, 0, []);
    let outcome = await this.#run(executor, executorHandoff(this.#task, plan, verify.approved));
    const maxRevisions = options.maxRevisions ?? MAX_REVISIONS;
    for (;;) {
      const result = this.#parse(TeamResultSchema, outcome, "executor");
      const feedback = await this.#evaluateRound(environment, plan, verify, result);
      if (feedback === undefined) {
        break;
      }
      if (this.#revisions >= maxRevisions) {
        throw new RunStop("needs-human", "revision-limit", `the change still needs revision after ${String(maxRevisions)} round(s)`);
      }
      this.#revisions += 1;
      await this.#phase("revise", `round ${String(this.#revisions)}`);
      outcome = await this.#run(executor, feedback);
    }

    await this.#phase("commit");
    const commit = await this.#worktreeGit((repo) => repo.commit(commitMessage(plan.title)));
    if (commit.committed && commit.commit !== undefined) {
      this.#commit = commit.commit;
    } else if (!commit.committed) {
      this.#commitError = commit.reason ?? "nothing was committed";
    }
  }

  async #makePlan(environment: Environment): Promise<{ plan: TeamPlan; verify: CommandApproval }> {
    const options = this.#options;
    const delegate = createDelegateTool((task, signal) => this.#research(environment, task, signal));
    const lead = await this.#session("lead", environment, 0, [delegate]);
    let outcome = await this.#run(lead, leadHandoff(this.#task));
    for (let corrections = 0; ; corrections += 1) {
      const plan = this.#parse(TeamPlanSchema, outcome, "lead");
      const verdicts = await evaluateCommands(plan.verify, options.commandPolicy, options.root);
      const problems = [
        ...scopeProblems(plan),
        ...verdicts
          .filter((verdict) => verdict.decision === "deny")
          .map((verdict) => `verify command ${argvText(verdict.command)} is denied by policy: ${verdict.reason}`),
      ];
      if (problems.length === 0) {
        const verify = await approveCommands(plan.verify, {
          policy: options.commandPolicy,
          cwd: options.root,
          trusted: options.trusted,
          purpose: "verify",
          ...(options.approveCommands === undefined ? {} : { approver: options.approveCommands }),
        });
        this.#unapproved.push(...verify.unapproved);
        if (verify.unapproved.length > 0) {
          await this.#phase("plan", `${String(verify.unapproved.length)} verify command(s) not approved and will be skipped`);
        }
        return { plan, verify };
      }
      if (corrections >= MAX_PLAN_CORRECTIONS) {
        throw new RunStop("failed", "invalid-plan", problems.join("; "));
      }
      this.#planCorrections += 1;
      await this.#phase("plan", "correction requested");
      outcome = await this.#run(lead, planCorrection(problems));
    }
  }

  async #research(environment: Environment, task: DelegateTask, signal: AbortSignal): Promise<DelegateReport> {
    const session = await this.#session("researcher", environment, 1, []);
    const outcome = await session.run(researchHandoff(task), { signal, listeners: this.#listeners() });
    this.#recordOutcome(session.id, outcome);
    if (outcome.type === "completed") {
      const parsed = TeamResultSchema.safeParse(outcome.result);
      if (parsed.success) {
        const summary = [parsed.data.summary, parsed.data.notes ?? ""].filter((part) => part.length > 0).join("\n\n");
        return { title: task.title, status: "completed", summary };
      }
      return { title: task.title, status: "failed", summary: "the researcher returned an invalid result" };
    }
    return { title: task.title, status: "failed", summary: describeStopped(outcome) };
  }

  async #approveSetup(): Promise<readonly TeamCommand[]> {
    const options = this.#options;
    const setup = options.setup ?? [];
    if (setup.length === 0) {
      return [];
    }
    if (!options.trusted) {
      this.#unapproved.push(...setup);
      await this.#phase("setup", "skipped because the workspace is not trusted");
      return [];
    }
    const approval = await approveCommands(setup, {
      policy: options.commandPolicy,
      cwd: options.root,
      trusted: true,
      purpose: "setup",
      ...(options.approveCommands === undefined ? {} : { approver: options.approveCommands }),
    });
    const denied = approval.denied[0];
    if (denied !== undefined) {
      throw new RunStop("failed", "setup", `setup command ${argvText(denied.command)} is denied by policy: ${denied.reason}`);
    }
    if (approval.unapproved.length > 0) {
      this.#unapproved.push(...approval.unapproved);
      await this.#phase("setup", `${String(approval.unapproved.length)} setup command(s) not approved and will be skipped`);
    }
    return approval.approved;
  }

  async #runSetup(environment: Environment, commands: readonly TeamCommand[]): Promise<void> {
    if (commands.length === 0) {
      return;
    }
    await this.#phase("setup");
    const runs = await runCommands(environment, commands, { redactor: this.#options.redactor, signal: this.#controller.signal });
    this.#checkpoint();
    const failed = runs.find((run) => !run.ok);
    if (failed !== undefined) {
      const status = failed.timedOut ? "timed out" : `exited with code ${String(failed.exitCode)}`;
      throw new RunStop("failed", "setup", `setup command ${argvText(failed.command)} ${status}\n${failed.outputTail}`);
    }
  }

  async #evaluateRound(
    environment: Environment,
    plan: TeamPlan,
    verify: CommandApproval,
    result: TeamResult,
  ): Promise<string | undefined> {
    await this.#phase("collect");
    const changes = await this.#collect(environment, plan);
    if (changes.sensitive.length > 0) {
      this.#sensitiveChanges = [...changes.sensitive];
      this.#verification = { ...SKIPPED, unapproved: [...verify.approved, ...verify.unapproved] };
      throw new RunStop("needs-human", "sensitive-changes", `changes need human review: ${changes.sensitive.join(", ")}`);
    }
    if (changes.outOfScope.length > 0) {
      await this.#phase("collect", `${String(changes.outOfScope.length)} path(s) outside the plan scope`);
      return scopeFeedback(changes.outOfScope);
    }

    await this.#phase("verify");
    this.#verification = await this.#verify(environment, verify);
    await this.#refreshIgnored();
    const failedRun = this.#verification.runs.find((run) => !run.ok);
    if (failedRun !== undefined) {
      return verificationFeedback(failedRun);
    }

    await this.#phase("review");
    const review = await this.#reviewChange(environment, plan, result);
    this.#review = review;
    await this.#phase("review", review.verdict);
    if (review.verdict === "approve") {
      return undefined;
    }
    if (review.verdict === "block") {
      throw new RunStop("blocked", "review-blocked", review.summary);
    }
    return reviewFeedback(review);
  }

  async #collect(environment: Environment, plan: TeamPlan): Promise<Changes> {
    const base = this.#requireBase();
    try {
      await this.#worktreeGit((repo) => repo.stageAll());
      const changed = await this.#worktreeGit((repo) => repo.changedPaths(base));
      const written = [...this.#writes].sort();
      const ignoredWrites = written.length === 0 ? [] : await this.#worktreeGit((repo) => repo.isIgnored(written));
      await this.#refreshIgnored();
      const classification = classifyChanges(unique(changed), plan, !environment.caseSensitive);
      return {
        sensitive: unique([...classification.sensitive, ...ignoredWrites]),
        outOfScope: classification.outOfScope,
      };
    } catch (error) {
      if (error instanceof ChangesetTooLargeError) {
        throw new RunStop("needs-human", "changeset-too-large", error.message);
      }
      throw error;
    }
  }

  async #verify(environment: Environment, verify: CommandApproval): Promise<VerificationSummary> {
    const runs =
      verify.approved.length === 0
        ? []
        : await runCommands(environment, verify.approved, { redactor: this.#options.redactor, signal: this.#controller.signal });
    this.#checkpoint();
    const failed = runs.some((run) => !run.ok);
    const complete = verify.unapproved.length === 0 && verify.approved.length > 0 && runs.length === verify.approved.length;
    const status: VerificationStatus = failed ? "failed" : complete ? "passed" : "skipped";
    return { status, runs, unapproved: verify.unapproved };
  }

  async #reviewChange(environment: Environment, plan: TeamPlan, result: TeamResult): Promise<TeamReview> {
    const base = this.#requireBase();
    const reviewer = await this.#session("reviewer", environment, 0, []);
    const diff = await this.#worktreeGit((repo) => repo.diff(base, MAX_REVIEW_DIFF_BYTES));
    const reviewDiff: ReviewDiff = diff.truncated
      ? { stat: await this.#worktreeGit((repo) => repo.diffStat(base)) }
      : { text: diff.text };
    const input = this.#options.redactor.redact(
      reviewerHandoff({ task: this.#task, plan, result, verification: this.#verification, diff: reviewDiff }),
    );
    const outcome = await this.#run(reviewer, input);
    return this.#parse(TeamReviewSchema, outcome, "reviewer");
  }

  async #session(
    role: AgentRole,
    environment: Environment,
    depth: number,
    extra: readonly ToolDefinition[],
  ): Promise<AgentSession> {
    const options = this.#options;
    const config = options.roles[role];
    const resolved = options.resolveModel(config.model);
    const base = options
      .toolsFor(role, environment)
      .filter((tool) => !RESERVED_TEAM_TOOLS.has(tool.name) && (role === "executor" || tool.capabilities.readOnly));
    const tools = [...base, ...extra, COMPLETION_TOOLS[role]()];
    const spec = roleSpec(role, config, tools.map((tool) => tool.name));
    const id = ulid(this.#now().getTime());
    const log = options.openSessionLog === undefined ? new InMemoryEventSink(this.#now) : await options.openSessionLog(id, role);
    this.#logs.push(log);
    const gate = options.permissionsFor(role, environment);
    this.#sessions.push({ id, role, provider: resolved.provider.id, model: config.model.id });
    return new AgentSession({
      id,
      spec,
      provider: resolved.provider,
      model: resolved.model,
      tools,
      environment,
      permissions: role === "executor" ? recordWrites(gate, environment, this.#writes) : gate,
      redactor: options.redactor,
      events: log,
      systemPrompt: buildSystemPrompt({
        agentName: spec.name,
        role,
        instructions: spec.instructions,
        platform: options.platform ?? process.platform,
        root: environment.root,
        createdAt: this.#now(),
      }),
      ...(this.#context === undefined ? {} : { projectContext: this.#context }),
      ledger: this.#roleLedger(role).child(spec.name),
      depth,
    });
  }

  async #run(session: AgentSession, input: string): Promise<Completed> {
    this.#checkpoint();
    const outcome = await session.run(input, { signal: this.#controller.signal, listeners: this.#listeners() });
    this.#recordOutcome(session.id, outcome);
    if (outcome.type === "completed") {
      return outcome;
    }
    throw this.#stopFor(outcome, session.spec.role);
  }

  #parse<T>(schema: z.ZodType<T>, outcome: Completed, role: AgentRole): T {
    const parsed = schema.safeParse(outcome.result);
    if (!parsed.success) {
      throw new RunStop("failed", "invalid-completion", `the ${role} submitted a result that does not match its schema`);
    }
    return parsed.data;
  }

  #roleLedger(role: AgentRole): UsageLedger {
    let ledger = this.#roleLedgers.get(role);
    if (ledger === undefined) {
      ledger = this.#ledger.child(role);
      this.#roleLedgers.set(role, ledger);
    }
    return ledger;
  }

  #listeners(): EventListener[] {
    return [...(this.#options.listeners ?? []), this.#budgetListener];
  }

  #recordOutcome(sessionId: string, outcome: TurnOutcome): void {
    const entry = this.#sessions.find((item) => item.id === sessionId);
    if (entry !== undefined) {
      entry.outcome = outcome.type;
    }
  }

  #stopFor(outcome: Stopped, role: AgentRole): RunStop {
    if (this.#controller.signal.aborted) {
      return this.#abortStop();
    }
    switch (outcome.type) {
      case "refused":
        return new RunStop("needs-human", "refused", `the ${role} refused to continue`, outcome.stopDetails);
      case "budget-exceeded":
        return new RunStop("budget-exceeded", `budget-${outcome.budget}`, `the ${role} exceeded its ${outcome.budget} budget`);
      case "aborted":
        return new RunStop("aborted", "aborted", "the run was aborted");
      case "failed":
        return new RunStop("failed", outcome.code, outcome.message);
      case "loop-detected":
        return new RunStop("failed", "loop-detected", `the ${role} repeated \`${outcome.tool}\` without progress`);
      case "max-tokens":
        return new RunStop("failed", "max-tokens", `the ${role} hit the output token limit`);
    }
  }

  #abortStop(): RunStop {
    if (this.#exceeded !== undefined) {
      return new RunStop("budget-exceeded", `budget-${this.#exceeded}`, `the run exceeded its ${this.#exceeded} budget`);
    }
    return new RunStop("aborted", "aborted", "the run was aborted");
  }

  #checkpoint(): void {
    if (this.#controller.signal.aborted) {
      throw this.#abortStop();
    }
  }

  #toStop(error: unknown): RunStop {
    if (error instanceof RunStop) {
      return error;
    }
    if (this.#controller.signal.aborted) {
      return this.#abortStop();
    }
    return new RunStop("failed", "internal", errorMessage(error));
  }

  #checkCost(): void {
    const max = this.#options.budget?.maxCostUsd;
    if (max !== undefined && this.#exceeded === undefined && this.#ledger.snapshot().costUsd >= max) {
      this.#exceeded = "cost";
      this.#controller.abort();
    }
  }

  #attachSignals(): () => void {
    const external = this.#options.signal;
    const onAbort = (): void => {
      this.#controller.abort();
    };
    if (external?.aborted === true) {
      this.#controller.abort();
    } else {
      external?.addEventListener("abort", onAbort, { once: true });
    }
    const maxWallMs = this.#options.budget?.maxWallMs;
    const timer =
      maxWallMs === undefined
        ? undefined
        : setTimeout(() => {
            this.#exceeded ??= "wall";
            this.#controller.abort();
          }, maxWallMs);
    timer?.unref();
    return () => {
      external?.removeEventListener("abort", onAbort);
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }

  async #phase(phase: string, detail?: string): Promise<void> {
    await this.#options.events.append({ type: "team-phase", phase, ...(detail === undefined ? {} : { detail }) });
  }

  async #ensureIntact(repos: readonly RepoOps[]): Promise<void> {
    for (const repo of repos) {
      const report = await repo.checkIntegrity();
      if (!report.ok) {
        this.#integrityFailed = true;
        throw new RunStop("failed", "repo-integrity", report.problems.join("; "));
      }
    }
  }

  async #mainGit<T>(operation: () => Promise<T>): Promise<T> {
    await this.#ensureIntact([this.#options.repo]);
    return operation();
  }

  async #worktreeGit<T>(operation: (repo: RepoOps) => Promise<T>): Promise<T> {
    const repo = this.#worktreeRepo;
    if (repo === undefined) {
      throw new Error("the worktree has not been created");
    }
    await this.#ensureIntact([this.#options.repo, repo]);
    return operation(repo);
  }

  #requireBase(): string {
    if (this.#baseCommit === undefined) {
      throw new Error("the base commit is not known");
    }
    return this.#baseCommit;
  }

  async #refreshIgnored(): Promise<void> {
    if (this.#worktreeRepo === undefined) {
      return;
    }
    const current = await this.#worktreeGit((repo) => repo.listIgnored());
    this.#ignoredPaths = current.filter((item) => !this.#setupBaseline.has(item)).slice(0, MAX_IGNORED_PATHS);
  }

  async #refreshIgnoredQuietly(): Promise<void> {
    if (this.#integrityFailed) {
      return;
    }
    try {
      await this.#refreshIgnored();
    } catch {
      return;
    }
  }

  async #finish(status: TeamStatus, stop?: RunStop): Promise<TeamOutcome> {
    await this.#phase("done", stop === undefined ? status : `${status}: ${stop.code}`).catch(() => undefined);
    return {
      runId: this.#runId,
      status,
      ...(stop === undefined ? {} : { code: stop.code, message: stop.message }),
      ...(stop?.stopDetails === undefined ? {} : { stopDetails: stop.stopDetails }),
      verification: this.#verification.status,
      verificationRuns: this.#verification.runs,
      unapprovedCommands: [...this.#unapproved],
      sensitiveChanges: [...this.#sensitiveChanges],
      ignoredPaths: [...this.#ignoredPaths],
      ...(this.#branch === undefined ? {} : { branch: this.#branch }),
      ...(this.#worktreePath === undefined ? {} : { worktreePath: this.#worktreePath }),
      ...(this.#baseCommit === undefined ? {} : { baseCommit: this.#baseCommit }),
      ...(this.#commit === undefined ? {} : { commit: this.#commit }),
      ...(this.#commitError === undefined ? {} : { commitError: this.#commitError }),
      ...(this.#plan === undefined ? {} : { plan: this.#plan }),
      ...(this.#review === undefined ? {} : { review: this.#review }),
      revisions: this.#revisions,
      planCorrections: this.#planCorrections,
      sessions: this.#sessions.map((entry) => ({ ...entry })),
      usage: this.#ledger.snapshot(),
      usageByRole: Object.fromEntries([...this.#roleLedgers].map(([role, ledger]) => [role, ledger.snapshot()])),
    };
  }
}

export function runTeam(task: string, options: RunTeamOptions): Promise<TeamOutcome> {
  return new TeamRun(task, options).execute();
}
