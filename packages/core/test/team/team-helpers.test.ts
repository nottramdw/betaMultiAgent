import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  approveCommands,
  classifyChanges,
  defaultTeamRoles,
  roleSpec,
  scopePatternProblem,
  tailText,
  TeamConfigError,
  toRelativePosix,
  type CommandPolicy,
  type PermissionVerdict,
} from "../../src/index.js";

function policy(decide: (program: string) => PermissionVerdict["decision"]): CommandPolicy {
  return {
    evaluate: (request) =>
      Promise.resolve({
        decision: request.kind === "exec" ? decide(request.argv[0] ?? "") : "allow",
        source: "rule",
        reason: "test",
        sensitive: false,
      }),
  };
}

describe("scope patterns", () => {
  it.each([
    ["src/**", undefined],
    ["", "is empty"],
    ["src\\a.ts", "must use forward slashes"],
    ["/etc/**", "must be relative to the workspace root"],
    ["C:/x", "must be relative to the workspace root"],
    ["src/../x", "must not contain '..'"],
  ])("checks %j", (pattern, problem) => {
    expect(scopePatternProblem(pattern)).toBe(problem);
  });

  it("classifies sensitive and out-of-scope paths", () => {
    const rules = { inScope: ["src/**", ".env.example"], outOfScope: ["src/vendor/**"] };
    const result = classifyChanges(["src/a.ts", "src/vendor/x.js", "package.json", ".env", ".env.example", "README.md"], rules, false);
    expect(result.sensitive).toEqual(["package.json", ".env"]);
    expect(result.outOfScope).toEqual(["src/vendor/x.js", "package.json", ".env", "README.md"]);
  });

  it("matches scope case-insensitively on case-insensitive file systems", () => {
    const rules = { inScope: ["src/**"], outOfScope: [] };
    expect(classifyChanges(["SRC/a.ts"], rules, true).outOfScope).toEqual([]);
    expect(classifyChanges(["SRC/a.ts"], rules, false).outOfScope).toEqual(["SRC/a.ts"]);
  });

  it("converts paths inside the root to relative POSIX paths", () => {
    const root = path.resolve("/work");
    expect(toRelativePosix(root, path.join(root, "src", "a.ts"))).toBe("src/a.ts");
    expect(toRelativePosix(root, "src/b.ts")).toBe("src/b.ts");
    expect(toRelativePosix(root, path.resolve("/elsewhere/a.ts"))).toBeUndefined();
    expect(toRelativePosix(root, root)).toBeUndefined();
  });
});

describe("command approval", () => {
  const commands = [{ argv: ["node", "--test"] }, { argv: ["make", "check"] }, { argv: ["git", "push"] }];
  const decide = (program: string): PermissionVerdict["decision"] =>
    program === "node" ? "allow" : program === "git" ? "deny" : "ask";

  it("approves allowed commands and asks about the rest in one batch", async () => {
    const asked: string[] = [];
    const result = await approveCommands(commands, {
      policy: policy(decide),
      cwd: "/work",
      trusted: true,
      purpose: "verify",
      approver: (pending) => {
        asked.push(...pending.map((command) => command.argv.join(" ")));
        return Promise.resolve(true);
      },
    });
    expect(asked).toEqual(["make check"]);
    expect(result.approved.map((command) => command.argv[0])).toEqual(["node", "make"]);
    expect(result.unapproved).toEqual([]);
    expect(result.denied.map((item) => item.command.argv[0])).toEqual(["git"]);
  });

  it("leaves commands needing approval unapproved without an approver", async () => {
    const result = await approveCommands(commands, { policy: policy(decide), cwd: "/work", trusted: true, purpose: "verify" });
    expect(result.approved.map((command) => command.argv[0])).toEqual(["node"]);
    expect(result.unapproved.map((command) => command.argv[0])).toEqual(["make"]);
  });

  it("approves nothing in an untrusted workspace", async () => {
    const result = await approveCommands(commands, {
      policy: policy(decide),
      cwd: "/work",
      trusted: false,
      purpose: "verify",
      approver: () => Promise.resolve(true),
    });
    expect(result.approved).toEqual([]);
    expect(result.unapproved.map((command) => command.argv[0])).toEqual(["node", "make"]);
  });
});

describe("tailText", () => {
  it("keeps short text unchanged", () => {
    expect(tailText("short", 10)).toBe("short");
  });

  it("keeps the end of long text without splitting a UTF-8 sequence", () => {
    const result = tailText(`${"a".repeat(20)}ééé`, 5);
    expect(result).toMatch(/^\[\.\.\. \d+ bytes omitted \.\.\.\]\n/u);
    expect(result.endsWith("éé")).toBe(true);
    expect(result).not.toContain("\uFFFD");
  });
});

describe("team roles", () => {
  it("uses the other provider for review when both are available", () => {
    const roles = defaultTeamRoles({ claude: true, grok: true });
    expect(roles.executor.model).toEqual({ provider: "claude", id: "claude-sonnet-5-5" });
    expect(roles.reviewer.model).toEqual({ provider: "grok", id: "grok-4.7" });
  });

  it("uses a different model for review with a single provider", () => {
    const claude = defaultTeamRoles({ claude: true, grok: false });
    expect(claude.reviewer.model.id).not.toBe(claude.executor.model.id);
    const grok = defaultTeamRoles({ claude: false, grok: true });
    expect(grok.reviewer.model.id).not.toBe(grok.executor.model.id);
  });

  it("requires a provider", () => {
    expect(() => defaultTeamRoles({ claude: false, grok: false })).toThrow(TeamConfigError);
  });

  it("builds a spec with the role's completion tool and turn budget", () => {
    const spec = roleSpec("reviewer", { model: { provider: "claude", id: "m" }, maxTurns: 5 }, ["read_file", "submit_review"]);
    expect(spec).toMatchObject({ name: "reviewer", role: "reviewer", budget: { maxTurns: 5 }, completion: { tool: "submit_review" } });
  });
});
