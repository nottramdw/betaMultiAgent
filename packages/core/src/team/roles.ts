import type { AgentRole, AgentSpec, ModelRef } from "../agent/agent-spec.js";
import type { Permissions } from "../permissions/permission-types.js";
import { SUBMIT_PLAN, SUBMIT_RESULT, SUBMIT_REVIEW } from "./completion-tools.js";
import { DELEGATE_TOOL } from "./delegate-tool.js";

export const TEAM_ROLES = ["lead", "researcher", "executor", "reviewer"] as const satisfies readonly AgentRole[];

export const RESERVED_TEAM_TOOLS: ReadonlySet<string> = new Set([SUBMIT_PLAN, SUBMIT_RESULT, SUBMIT_REVIEW, DELEGATE_TOOL]);

export const ROLE_COMPLETION_TOOL: Readonly<Record<AgentRole, string>> = {
  lead: SUBMIT_PLAN,
  researcher: SUBMIT_RESULT,
  executor: SUBMIT_RESULT,
  reviewer: SUBMIT_REVIEW,
};

export const DEFAULT_MAX_TURNS: Readonly<Record<AgentRole, number>> = {
  lead: 40,
  researcher: 30,
  executor: 120,
  reviewer: 40,
};

export const ROLE_INSTRUCTIONS: Readonly<Record<AgentRole, string>> = {
  lead: [
    "Investigate the workspace with the read-only tools and write an implementation plan for the task. You cannot change files.",
    `Use \`${DELEGATE_TOOL}\` to run focused research tasks in parallel when that saves time.`,
    `Finish by calling \`${SUBMIT_PLAN}\` with a short title, ordered steps, \`inScope\` glob patterns covering every path the executor may change, \`outOfScope\` patterns for paths that must stay untouched, \`verify\` commands given as argv arrays that prove the change works, and stop conditions.`,
    "Glob patterns are POSIX paths relative to the workspace root. Verification commands run without a shell.",
  ].join("\n"),
  researcher: [
    "Answer the research question with the read-only tools. You cannot change files.",
    `Finish by calling \`${SUBMIT_RESULT}\` with a concise, factual summary that cites file paths.`,
  ].join("\n"),
  executor: [
    "Implement the plan given in the handoff message.",
    "Change only paths matched by `inScope` and never paths matched by `outOfScope`. Do not create commits.",
    `Finish by calling \`${SUBMIT_RESULT}\` with a summary of what changed and anything left undone.`,
  ].join("\n"),
  reviewer: [
    "Review the change against the plan, using the diff and verification results in the handoff message. Read files as needed; you cannot change them.",
    `Finish by calling \`${SUBMIT_REVIEW}\`: \`approve\` when the change is correct and complete, \`revise\` with actionable findings when the executor should fix it, \`block\` when the change is unsafe or the task cannot be done as planned.`,
  ].join("\n"),
};

export interface RoleConfig {
  readonly model: ModelRef;
  readonly instructions?: string;
  readonly maxTurns?: number;
  readonly permissions?: Permissions;
}

export type TeamRoles = Readonly<Record<AgentRole, RoleConfig>>;

export interface ProviderAvailability {
  readonly claude: boolean;
  readonly grok: boolean;
}

export class TeamConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeamConfigError";
  }
}

const CLAUDE = "claude";
const GROK = "grok";

const CLAUDE_MODELS: Readonly<Record<AgentRole, string>> = {
  lead: "claude-opus-5-5",
  researcher: "claude-haiku-5-5",
  executor: "claude-sonnet-5-5",
  reviewer: "claude-opus-5-5",
};

const GROK_MODELS: Readonly<Record<AgentRole, string>> = {
  lead: "grok-4.7",
  researcher: "grok-4.3",
  executor: "grok-4.7",
  reviewer: "grok-4.3",
};

export function defaultTeamRoles(available: ProviderAvailability): TeamRoles {
  if (available.claude) {
    const claude = (role: AgentRole): RoleConfig => ({ model: { provider: CLAUDE, id: CLAUDE_MODELS[role] } });
    return {
      lead: claude("lead"),
      researcher: claude("researcher"),
      executor: claude("executor"),
      reviewer: available.grok ? { model: { provider: GROK, id: GROK_MODELS.lead } } : claude("reviewer"),
    };
  }
  if (available.grok) {
    const grok = (role: AgentRole): RoleConfig => ({ model: { provider: GROK, id: GROK_MODELS[role] } });
    return { lead: grok("lead"), researcher: grok("researcher"), executor: grok("executor"), reviewer: grok("reviewer") };
  }
  throw new TeamConfigError("no provider is available; configure an Anthropic or xAI API key");
}

export function roleSpec(role: AgentRole, config: RoleConfig, tools: readonly string[]): AgentSpec {
  return {
    name: role,
    role,
    instructions: config.instructions ?? ROLE_INSTRUCTIONS[role],
    model: config.model,
    tools: [...tools],
    permissions: config.permissions ?? { rules: [], extraReadRoots: [] },
    budget: { maxTurns: config.maxTurns ?? DEFAULT_MAX_TURNS[role] },
    completion: { tool: ROLE_COMPLETION_TOOL[role] },
  };
}
