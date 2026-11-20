import path from "node:path";
import type { PathMode, ResolvedPath } from "../environment/environment.js";
import { execRuleMatches, gitHardDenyReason, hasPathSeparator, pathCandidates, validateExecRule } from "./exec-policy.js";
import { compileDefaultMatchers, compileMatcher, type DefaultPathMatchers, type PathMatcher } from "./path-patterns.js";
import {
  PermissionConfigError,
  PermissionsSchema,
  type ApprovalAnswer,
  type Approver,
  type Decision,
  type ExecRule,
  type PermissionOutcome,
  type PermissionRequest,
  type PermissionVerdict,
  type Permissions,
  type VerdictSource,
} from "./permission-types.js";

export interface PermissionEngineOptions {
  readonly root: string;
  readonly platform?: NodeJS.Platform;
  readonly permissions?: Permissions;
  readonly trusted: boolean;
  readonly stateDir?: string;
  readonly configDir?: string;
  readonly approver?: Approver;
  readonly resolvePath: (path: string, mode: PathMode) => Promise<ResolvedPath>;
}

type PathKind = "read" | "write";

interface CompiledPathRule {
  readonly kind: PathKind;
  readonly decision: Decision;
  readonly match: PathMatcher;
  readonly pattern: string;
}

const SEVERITY: Record<Decision, number> = { allow: 0, ask: 1, deny: 2 };

function verdict(decision: Decision, source: VerdictSource, reason: string, sensitive = false): PermissionVerdict {
  return { decision, source, reason, sensitive };
}

function mostSevere(verdicts: readonly PermissionVerdict[]): PermissionVerdict {
  const sensitive = verdicts.some((item) => item.sensitive);
  const worst = verdicts.reduce((acc, item) => (SEVERITY[item.decision] > SEVERITY[acc.decision] ? item : acc));
  return { ...worst, sensitive };
}

function strictestRule<T extends { readonly decision: Decision }>(matches: readonly T[]): T | undefined {
  return matches.reduce<T | undefined>(
    (acc, item) => (acc === undefined || SEVERITY[item.decision] > SEVERITY[acc.decision] ? item : acc),
    undefined,
  );
}

export class PermissionEngine {
  readonly #platform: NodeJS.Platform;
  readonly #paths: path.PlatformPath;
  readonly #nocase: boolean;
  readonly #root: string;
  readonly #extraReadRoots: readonly string[];
  readonly #trusted: boolean;
  readonly #stateDir: string | undefined;
  readonly #configDir: string | undefined;
  readonly #approver: Approver | undefined;
  readonly #resolvePath: PermissionEngineOptions["resolvePath"];
  readonly #defaults: DefaultPathMatchers;
  readonly #pathRules: readonly CompiledPathRule[];
  readonly #execRules: readonly ExecRule[];
  readonly #sessionPaths = new Set<string>();
  readonly #sessionExec: ExecRule[] = [];
  #execAllowRevoked = false;

  constructor(options: PermissionEngineOptions) {
    this.#platform = options.platform ?? process.platform;
    this.#paths = this.#platform === "win32" ? path.win32 : path.posix;
    this.#nocase = this.#platform === "win32" || this.#platform === "darwin";
    this.#root = options.root;
    this.#trusted = options.trusted;
    this.#stateDir = options.stateDir;
    this.#configDir = options.configDir;
    this.#approver = options.approver;
    this.#resolvePath = options.resolvePath;
    this.#defaults = compileDefaultMatchers(this.#nocase);

    const parsed = PermissionsSchema.safeParse(options.permissions ?? { rules: [], extraReadRoots: [] });
    if (!parsed.success) {
      throw new PermissionConfigError(`invalid permissions: ${parsed.error.message}`);
    }
    this.#extraReadRoots = parsed.data.extraReadRoots;
    const pathRules: CompiledPathRule[] = [];
    const execRules: ExecRule[] = [];
    for (const rule of parsed.data.rules) {
      if (rule.kind === "exec") {
        validateExecRule(rule, this.#platform);
        execRules.push(rule);
      } else {
        pathRules.push({
          kind: rule.kind,
          decision: rule.decision,
          pattern: rule.match,
          match: compileMatcher([rule.match], this.#nocase),
        });
      }
    }
    this.#pathRules = pathRules;
    this.#execRules = execRules;
  }

  get execAllowRevoked(): boolean {
    return this.#execAllowRevoked;
  }

  async evaluate(request: PermissionRequest): Promise<PermissionVerdict> {
    switch (request.kind) {
      case "none":
        return verdict("allow", "default", "no permission required");
      case "read":
      case "write":
        return mostSevere(await Promise.all(request.paths.map((item) => this.#evaluateRequestedPath(item, request.kind))));
      case "exec":
        return this.#evaluateExec(request.argv, request.cwd);
    }
  }

  async authorize(request: PermissionRequest): Promise<PermissionOutcome> {
    const result = await this.evaluate(request);
    if (result.decision === "deny") {
      return { allowed: false, verdict: result };
    }
    if (result.decision === "allow") {
      this.#afterAllowed(request, result);
      return { allowed: true, verdict: result };
    }
    if (this.#approver === undefined) {
      return { allowed: false, verdict: { ...result, reason: `${result.reason}; no approver available` } };
    }
    const approval: ApprovalAnswer = await this.#approver(request, result);
    if (approval === "deny") {
      return { allowed: false, verdict: result, approval };
    }
    if (approval === "allow-session") {
      await this.#rememberSession(request);
    }
    this.#afterAllowed(request, result);
    return { allowed: true, verdict: result, approval };
  }

  async isPathDenied(target: string, mode: PathKind): Promise<boolean> {
    const result = await this.#evaluateRequestedPath(target, mode);
    return result.decision === "deny";
  }

  evaluateResolvedPath(absolutePath: string, kind: PathKind): PermissionVerdict {
    const hard = this.#hardDenyPath(absolutePath, kind);
    if (hard !== undefined) {
      return hard;
    }
    const location = this.#locate(absolutePath);
    const sensitive = kind === "write" && this.#defaults.sensitiveWrite(location.rel);

    if (location.base === "root") {
      const ruleMatch = strictestRule(this.#pathRules.filter((rule) => rule.kind === kind && rule.match(location.rel)));
      if (ruleMatch?.decision !== "deny" && this.#sessionPaths.has(this.#sessionKey(kind, absolutePath))) {
        return verdict("allow", "session", `${kind} allowed for this session`, sensitive);
      }
      if (ruleMatch !== undefined) {
        return verdict(ruleMatch.decision, "rule", `${kind} rule ${ruleMatch.pattern}`, sensitive);
      }
    }

    if (this.#defaults.secret(location.rel)) {
      return verdict("deny", "default", `${location.rel} matches a protected secret pattern`, sensitive);
    }
    if (kind === "write" && this.#defaults.gitWrite(location.rel)) {
      return verdict("deny", "default", "writing git metadata is not permitted", sensitive);
    }
    if (sensitive) {
      return verdict("ask", "default", `${location.rel} is a sensitive file`, true);
    }
    if (kind === "read" && location.base !== "outside") {
      return verdict("allow", "default", "read inside the workspace");
    }
    return verdict("ask", "fallback", `${kind} ${absolutePath} requires approval`);
  }

  async #evaluateRequestedPath(target: string, kind: PathKind): Promise<PermissionVerdict> {
    let resolved: ResolvedPath;
    try {
      resolved = await this.#resolvePath(target, kind);
    } catch (error) {
      return verdict("deny", "hard-deny", error instanceof Error ? error.message : `cannot resolve ${target}`);
    }
    return mostSevere([this.evaluateResolvedPath(resolved.requested, kind), this.evaluateResolvedPath(resolved.real, kind)]);
  }

  async #evaluateExec(argv: readonly string[], cwd: string): Promise<PermissionVerdict> {
    const hard = gitHardDenyReason(argv, this.#platform);
    if (hard !== undefined) {
      return verdict("deny", "hard-deny", hard);
    }
    const protectedToken = await this.#findProtectedToken(argv, cwd);
    if (protectedToken !== undefined) {
      return verdict("deny", protectedToken.source, `argument ${protectedToken.token}: ${protectedToken.reason}`);
    }

    const allowsIgnored = !this.#trusted || this.#execAllowRevoked;
    const program = argv[0] ?? "";
    const allowEligible = !allowsIgnored && !hasPathSeparator(program);
    const match = strictestRule(
      this.#execRules.filter(
        (rule) => (rule.decision !== "allow" || allowEligible) && execRuleMatches(rule, argv, this.#platform),
      ),
    );
    const sessionAllowed =
      allowEligible && this.#sessionExec.some((rule) => execRuleMatches(rule, argv, this.#platform));
    if (match?.decision !== "deny" && sessionAllowed) {
      return verdict("allow", "session", "command allowed for this session");
    }
    if (match !== undefined) {
      return verdict(match.decision, "rule", `exec rule ${JSON.stringify(match.match)}`);
    }
    const why = !this.#trusted
      ? "workspace is not trusted"
      : this.#execAllowRevoked
        ? "exec allow rules are suspended after a sensitive write"
        : "no exec rule allows this command";
    return verdict("ask", "fallback", why);
  }

  async #findProtectedToken(
    argv: readonly string[],
    cwd: string,
  ): Promise<{ token: string; reason: string; source: VerdictSource } | undefined> {
    for (const token of pathCandidates(argv)) {
      const absolute = this.#paths.resolve(cwd, token);
      const lexical = this.evaluateResolvedPath(absolute, "read");
      if (lexical.decision === "deny") {
        return { token, reason: lexical.reason, source: lexical.source };
      }
      try {
        const resolved = await this.#resolvePath(absolute, "read");
        const real = this.evaluateResolvedPath(resolved.real, "read");
        if (real.decision === "deny") {
          return { token, reason: real.reason, source: real.source };
        }
      } catch {
        continue;
      }
    }
    return undefined;
  }

  #afterAllowed(request: PermissionRequest, result: PermissionVerdict): void {
    if (request.kind === "write" && result.sensitive) {
      this.#execAllowRevoked = true;
    }
  }

  async #rememberSession(request: PermissionRequest): Promise<void> {
    if (request.kind === "exec") {
      this.#sessionExec.push({ kind: "exec", match: [...request.argv], decision: "allow" });
      return;
    }
    if (request.kind === "read" || request.kind === "write") {
      for (const item of request.paths) {
        try {
          const resolved = await this.#resolvePath(item, request.kind);
          this.#sessionPaths.add(this.#sessionKey(request.kind, resolved.requested));
          this.#sessionPaths.add(this.#sessionKey(request.kind, resolved.real));
        } catch {
          continue;
        }
      }
    }
  }

  #sessionKey(kind: PathKind, absolutePath: string): string {
    const normalized = this.#paths.normalize(absolutePath);
    return `${kind}:${this.#nocase ? normalized.toLowerCase() : normalized}`;
  }

  #relativeInside(base: string, target: string): string | undefined {
    const fold = (value: string): string => (this.#nocase ? value.toLowerCase() : value);
    const rel = this.#paths.relative(fold(this.#paths.resolve(base)), fold(this.#paths.resolve(target)));
    if (rel === ".." || rel.startsWith(`..${this.#paths.sep}`) || this.#paths.isAbsolute(rel)) {
      return undefined;
    }
    return rel.split(this.#paths.sep).join("/");
  }

  #locate(absolutePath: string): { base: "root" | "extra" | "outside"; rel: string } {
    const inRoot = this.#relativeInside(this.#root, absolutePath);
    if (inRoot !== undefined) {
      return { base: "root", rel: inRoot };
    }
    for (const extra of this.#extraReadRoots) {
      const inExtra = this.#relativeInside(extra, absolutePath);
      if (inExtra !== undefined) {
        return { base: "extra", rel: inExtra };
      }
    }
    const stripped = absolutePath.replaceAll("\\", "/").replace(/^[A-Za-z]:/u, "").replace(/^\/+/u, "");
    return { base: "outside", rel: stripped };
  }

  #hardDenyPath(absolutePath: string, kind: PathKind): PermissionVerdict | undefined {
    if (this.#stateDir !== undefined) {
      const inProjects = this.#relativeInside(this.#paths.join(this.#stateDir, "projects"), absolutePath);
      const trustFile = this.#relativeInside(this.#paths.join(this.#stateDir, "trust.json"), absolutePath);
      if (inProjects !== undefined || trustFile === "") {
        return verdict("deny", "hard-deny", "bma state files are not accessible to agents");
      }
    }
    if (kind === "write" && this.#configDir !== undefined && this.#relativeInside(this.#configDir, absolutePath) !== undefined) {
      return verdict("deny", "hard-deny", "bma configuration is not writable by agents");
    }
    return undefined;
  }
}
