import {
  createRedactor,
  defaultTeamRoles,
  PermissionEngine,
  ProviderError,
  TEAM_ROLES,
  TeamConfigError,
  type AgentRole,
  type RoleConfig,
  type TeamRoles,
  type Approver,
  type Environment,
  type ModelInfo,
  type ModelRef,
  type ModelResolver,
  type Provider,
  type ProviderAvailability,
  type ProviderId,
  type Redactor,
  type ToolDefinition,
} from "@betamultiagent/core";
import { createClaudeProvider, parseModelRef as parseClaudeModel } from "@betamultiagent/provider-claude";
import { createGrokProvider, parseModelRef as parseGrokModel } from "@betamultiagent/provider-grok";
import { createSkillTools, discoverSkills, renderSkillCatalog, type SkillRegistry } from "@betamultiagent/skills";
import { createDefaultTools, createGitWorktreeEnvironment, createLocalEnvironment } from "@betamultiagent/tools";
import { mkdir } from "node:fs/promises";
import type { CliIo } from "./cli-io.js";
import { usageError } from "./cli-error.js";
import { loadProjectConfig, loadUserConfig, type LoadedConfigFile } from "./config/load.js";
import { mergeConfig, type EffectiveConfig } from "./config/merge.js";
import { realpathLoose, resolveDirs, resolveWorkspaceRoot, type BmaDirs } from "./config/paths.js";
import { parseModelSpec, type BudgetConfig, type RoleConfigInput } from "./config/schema.js";
import { configDigest, isTrusted } from "./config/trust.js";

export const CREDENTIAL_VARIABLES = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "XAI_API_KEY"] as const;

export interface WiringOverrides {
  readonly providers?: Partial<Record<ProviderId, Provider>>;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

export function createCliRedactor(env: CliIo["env"]): Redactor {
  const secrets = CREDENTIAL_VARIABLES.map((name) => nonEmpty(env[name])).filter((value) => value !== undefined);
  return createRedactor({ secrets });
}

export function providerAvailability(env: CliIo["env"], overrides: WiringOverrides): ProviderAvailability {
  return {
    claude: overrides.providers?.["claude"] !== undefined || nonEmpty(env["ANTHROPIC_API_KEY"]) !== undefined,
    grok: overrides.providers?.["grok"] !== undefined || nonEmpty(env["XAI_API_KEY"]) !== undefined,
  };
}

export function catalogModel(ref: ModelRef): ModelInfo {
  if (ref.provider !== "claude" && ref.provider !== "grok") {
    throw usageError(`unknown provider ${JSON.stringify(ref.provider)}; expected claude or grok`);
  }
  try {
    return ref.provider === "claude" ? parseClaudeModel(ref) : parseGrokModel(ref);
  } catch (error) {
    if (error instanceof ProviderError) {
      throw usageError(error.message);
    }
    throw error;
  }
}

function buildProvider(id: ProviderId, env: CliIo["env"]): Provider {
  if (id !== "claude" && id !== "grok") {
    throw usageError(`unknown provider ${JSON.stringify(id)}; expected claude or grok`);
  }
  if (id === "claude") {
    const apiKey = nonEmpty(env["ANTHROPIC_API_KEY"]);
    if (apiKey === undefined) {
      throw usageError("ANTHROPIC_API_KEY is not set; Claude models need an API key in the environment");
    }
    return createClaudeProvider({ apiKey, baseURL: nonEmpty(env["ANTHROPIC_BASE_URL"]) });
  }
  const apiKey = nonEmpty(env["XAI_API_KEY"]);
  if (apiKey === undefined) {
    throw usageError("XAI_API_KEY is not set; Grok models need an API key in the environment");
  }
  return createGrokProvider({ apiKey, baseURL: nonEmpty(env["XAI_BASE_URL"]) });
}

export function createModelResolver(env: CliIo["env"], overrides: WiringOverrides): ModelResolver {
  const providers = new Map<ProviderId, Provider>();
  return (ref) => {
    const model = catalogModel(ref);
    let provider = providers.get(ref.provider);
    if (provider === undefined) {
      provider = overrides.providers?.[ref.provider] ?? buildProvider(ref.provider, env);
      providers.set(ref.provider, provider);
    }
    return { provider, model };
  };
}

export interface Workspace {
  readonly io: CliIo;
  readonly dirs: BmaDirs;
  readonly root: string;
  readonly userConfig: LoadedConfigFile;
  readonly projectConfig: LoadedConfigFile;
  readonly digest: string;
  readonly trusted: boolean;
  readonly config: EffectiveConfig;
  readonly redactor: Redactor;
}

export async function ensureStateDir(dirs: BmaDirs): Promise<void> {
  await mkdir(dirs.state, { recursive: true, mode: 0o700 });
}

export async function openWorkspace(io: CliIo, redactor: Redactor): Promise<Workspace> {
  const dirs = resolveDirs(io.env, io.platform, io.homedir);
  const root = resolveWorkspaceRoot(io.cwd, dirs, io.homedir, io.platform);
  const userConfig = await loadUserConfig(dirs);
  const projectConfig = await loadProjectConfig(root);
  const digest = configDigest(projectConfig.raw);
  const trusted = await isTrusted(dirs, root, digest);
  const config = mergeConfig(userConfig.config, projectConfig.config, trusted);
  return { io, dirs, root, userConfig, projectConfig, digest, trusted, config, redactor };
}

export function untrustedWarning(): string {
  return "bma: workspace is not trusted; project instructions, repo skills, project settings other than deny/ask rules, exec allow rules and verification approval are ignored (run `bma trust`)";
}

export function loadSkills(workspace: Workspace): Promise<SkillRegistry> {
  return discoverSkills({
    root: workspace.root,
    userConfigDir: workspace.dirs.config,
    trusted: workspace.trusted,
    extraRoots: workspace.config.extraSkillRoots,
  });
}

export function skillCatalog(skills: SkillRegistry): string | undefined {
  return skills.skills.length === 0 ? undefined : renderSkillCatalog(skills);
}

export function createEnvironment(workspace: Workspace, skills: SkillRegistry, root: string, kind: Environment["kind"]): Environment {
  const options = { root, extraReadRoots: skills.readRoots(), envPassthrough: workspace.config.passthrough };
  return kind === "local" ? createLocalEnvironment(options) : createGitWorktreeEnvironment(options);
}

export function createPermissionEngine(
  workspace: Workspace,
  environment: Environment,
  skills: SkillRegistry,
  approver: Approver | undefined,
): PermissionEngine {
  return new PermissionEngine({
    root: environment.root,
    platform: workspace.io.platform,
    permissions: { rules: [...workspace.config.rules], extraReadRoots: [...skills.readRoots()] },
    trusted: workspace.trusted,
    stateDir: realpathLoose(workspace.dirs.state),
    configDir: realpathLoose(workspace.dirs.config),
    ...(approver === undefined ? {} : { approver }),
    resolvePath: (target, mode) => environment.resolvePath(target, mode),
  });
}

export function createTools(environment: Environment, skills: SkillRegistry): readonly ToolDefinition[] {
  return [...createDefaultTools({ environment }), ...createSkillTools(skills)];
}

function roleOverride(base: RoleConfig | undefined, input: RoleConfigInput | undefined): RoleConfig | undefined {
  if (input === undefined) {
    return base;
  }
  let model: RoleConfig["model"] | undefined;
  if (input.model !== undefined) {
    model = parseModelSpec(input.model, input.effort);
  } else if (base !== undefined) {
    model = input.effort === undefined ? base.model : { ...base.model, effort: input.effort };
  }
  if (model === undefined) {
    return undefined;
  }
  const instructions = input.instructions ?? base?.instructions;
  const maxTurns = input.maxTurns ?? base?.maxTurns;
  const maxCostUsd = input.maxCostUsd ?? base?.maxCostUsd;
  return {
    model,
    ...(instructions === undefined ? {} : { instructions }),
    ...(maxTurns === undefined ? {} : { maxTurns }),
    ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
  };
}

export function teamRoles(workspace: Workspace, overrides: WiringOverrides): TeamRoles {
  let defaults: TeamRoles | undefined;
  try {
    defaults = defaultTeamRoles(providerAvailability(workspace.io.env, overrides));
  } catch (error) {
    if (!(error instanceof TeamConfigError)) {
      throw error;
    }
  }
  const resolved: Partial<Record<AgentRole, RoleConfig>> = {};
  for (const role of TEAM_ROLES) {
    const config = roleOverride(defaults?.[role], workspace.config.roles[role]);
    if (config === undefined) {
      throw usageError("no API key is configured; set ANTHROPIC_API_KEY or XAI_API_KEY");
    }
    resolved[role] = config;
  }
  return resolved as TeamRoles;
}

export function wallMs(budget: BudgetConfig): number | undefined {
  return budget.maxWallMinutes === undefined ? undefined : budget.maxWallMinutes * 60_000;
}
