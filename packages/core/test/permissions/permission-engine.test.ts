import path from "node:path";
import {
  PermissionConfigError,
  PermissionEngine,
  type PermissionEngineOptions,
  type Permissions,
  type Rule,
} from "../../src/index.js";
import { describe, expect, it } from "vitest";

const ROOT = "/repo";

function engine(
  options: {
    platform?: NodeJS.Platform;
    rules?: Rule[];
    extraReadRoots?: string[];
    trusted?: boolean;
    links?: Record<string, string>;
    root?: string;
  } & Partial<Pick<PermissionEngineOptions, "approver" | "stateDir" | "configDir">> = {},
): PermissionEngine {
  const platform = options.platform ?? "linux";
  const api = platform === "win32" ? path.win32 : path.posix;
  const root = options.root ?? ROOT;
  const permissions: Permissions = { rules: options.rules ?? [], extraReadRoots: options.extraReadRoots ?? [] };
  return new PermissionEngine({
    root,
    platform,
    permissions,
    trusted: options.trusted ?? true,
    ...(options.approver === undefined ? {} : { approver: options.approver }),
    ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
    ...(options.configDir === undefined ? {} : { configDir: options.configDir }),
    resolvePath: (target) => {
      const requested = api.resolve(root, target);
      return Promise.resolve({ requested, real: options.links?.[requested] ?? requested });
    },
  });
}

const read = (...paths: string[]) => ({ kind: "read" as const, paths });
const write = (...paths: string[]) => ({ kind: "write" as const, paths });
const exec = (...argv: string[]) => ({ kind: "exec" as const, argv, cwd: ROOT });

describe("permission precedence", () => {
  const rules: Rule[] = [
    { kind: "read", match: "src/**", decision: "allow" },
    { kind: "read", match: "src/private/**", decision: "ask" },
    { kind: "read", match: "src/private/x.ts", decision: "deny" },
  ];

  it.each([
    ["src/a.ts", "allow"],
    ["src/private/y.ts", "ask"],
    ["src/private/x.ts", "deny"],
  ])("%s -> %s", async (file, decision) => {
    expect((await engine({ rules }).evaluate(read(file))).decision).toBe(decision);
  });

  it("uses the strictest decision across all requested paths", async () => {
    expect((await engine({ rules }).evaluate(read("src/a.ts", "src/private/x.ts"))).decision).toBe("deny");
  });

  it("turns ask into deny without an approver", async () => {
    const outcome = await engine({ rules }).authorize(read("src/private/y.ts"));
    expect(outcome.allowed).toBe(false);
    expect(outcome.verdict.decision).toBe("ask");
  });
});

describe("path case sensitivity", () => {
  const rules: Rule[] = [{ kind: "write", match: "src/a.ts", decision: "allow" }];

  it.each([
    ["darwin", "/repo", "src/A.ts", "allow"],
    ["linux", "/repo", "src/A.ts", "ask"],
    ["win32", "C:\\repo", "src\\A.ts", "allow"],
  ] as const)("%s", async (platform, root, file, decision) => {
    expect((await engine({ platform, root, rules }).evaluate(write(file))).decision).toBe(decision);
  });

  it("denies secret files regardless of case on every platform", async () => {
    for (const platform of ["linux", "darwin"] as const) {
      const subject = engine({ platform });
      expect((await subject.evaluate(read(".ENV"))).decision).toBe("deny");
      expect((await subject.evaluate(read("apps/web/.env.local"))).decision).toBe("deny");
    }
    expect((await engine().evaluate(read("apps/web/.env.example"))).decision).toBe("allow");
  });
});

describe("headless defaults", () => {
  it("allows workspace reads, denies secrets and writes", async () => {
    const subject = engine();
    expect((await subject.authorize(read("src/a.ts"))).allowed).toBe(true);
    expect((await subject.authorize(read(".env"))).allowed).toBe(false);
    expect((await subject.authorize(write("src/a.ts"))).allowed).toBe(false);
  });

  it("opens extra read roots for reading only", async () => {
    const subject = engine({ extraReadRoots: ["/skills"] });
    expect((await subject.evaluate(read("/skills/demo/SKILL.md"))).decision).toBe("allow");
    expect((await subject.evaluate(read("/skills/demo/.env"))).decision).toBe("deny");
    expect((await subject.evaluate(write("/skills/demo/SKILL.md"))).decision).toBe("ask");
  });

  it("evaluates the realpath of symlinks", async () => {
    const subject = engine({ links: { "/repo/docs/x": "/repo/.env" } });
    expect((await subject.evaluate(read("docs/x"))).decision).toBe("deny");
  });

  it("denies writes to git metadata unless a configured rule overrides the default", async () => {
    const subject = engine({ rules: [{ kind: "write", match: "sub/**", decision: "allow" }] });
    expect((await subject.evaluate(write(".git"))).decision).toBe("deny");
    expect((await subject.evaluate(write("sub/.git/config"))).decision).toBe("allow");
  });

  it("lets configured rules override default deny but not hard deny", async () => {
    const subject = engine({
      rules: [
        { kind: "read", match: "src/messages.key", decision: "allow" },
        { kind: "read", match: "**", decision: "allow" },
      ],
      stateDir: "/repo/.state",
      configDir: "/repo/.config-bma",
    });
    expect((await subject.evaluate(read("src/messages.key"))).decision).toBe("allow");
    expect((await subject.evaluate(read(".state/trust.json"))).decision).toBe("deny");
    expect((await subject.evaluate(read(".state/projects/p/events.jsonl"))).decision).toBe("deny");
    expect((await subject.evaluate(write(".config-bma/config.json"))).decision).toBe("deny");
  });
});

describe("default git write deny", () => {
  it("denies sub/.git/config without a matching rule", async () => {
    expect((await engine().evaluate(write("sub/.git/config"))).decision).toBe("deny");
  });
});

describe("exec rules", () => {
  it("matches argv tokens exactly and never allows separator paths", async () => {
    const subject = engine({ rules: [{ kind: "exec", match: ["git", "status"], decision: "allow" }] });
    expect((await subject.evaluate(exec("git", "status"))).decision).toBe("allow");
    expect((await subject.evaluate(exec("./git", "status"))).decision).toBe("ask");
    expect((await subject.evaluate(exec("git", "status", "-s"))).decision).toBe("ask");
  });

  it("strips executable suffixes and folds case on win32", async () => {
    const subject = engine({
      platform: "win32",
      root: "C:\\repo",
      rules: [{ kind: "exec", match: ["git", "status"], decision: "allow" }],
    });
    const verdict = await subject.evaluate({ kind: "exec", argv: ["GIT.EXE", "status"], cwd: "C:\\repo" });
    expect(verdict.decision).toBe("allow");
  });

  it("supports trailing wildcards for ordinary programs", async () => {
    const subject = engine({ rules: [{ kind: "exec", match: ["cargo", "test", "*"], decision: "allow" }] });
    expect((await subject.evaluate(exec("cargo", "test", "--workspace"))).decision).toBe("allow");
  });

  it.each([["git"], ["gh"], ["pnpm"], ["node"], ["powershell"]])("rejects prefix rules for %s", (program) => {
    expect(() => engine({ rules: [{ kind: "exec", match: [program, "*"], decision: "allow" }] })).toThrow(
      PermissionConfigError,
    );
  });

  it("hard-denies dangerous git invocations even with an exact allow rule", async () => {
    const argv = ["git", "-c", "core.fsmonitor=x", "status"];
    const subject = engine({
      rules: [
        { kind: "exec", match: argv, decision: "allow" },
        { kind: "exec", match: ["git", "push"], decision: "allow" },
        { kind: "exec", match: ["git", "diff", "--ext-diff"], decision: "allow" },
      ],
    });
    expect((await subject.evaluate(exec(...argv))).decision).toBe("deny");
    expect((await subject.evaluate(exec("git", "push"))).decision).toBe("deny");
    expect((await subject.evaluate(exec("git", "diff", "--ext-diff"))).decision).toBe("deny");
  });

  it("denies arguments that resolve to protected files", async () => {
    const subject = engine({ rules: [{ kind: "exec", match: ["cat", "*"], decision: "allow" }] });
    expect((await subject.evaluate(exec("cat", ".env"))).decision).toBe("deny");
    expect((await subject.evaluate(exec("cat", "--file=config/.env.production"))).decision).toBe("deny");
    expect((await subject.evaluate(exec("cat", "README.md"))).decision).toBe("allow");
  });

  it("ignores exec allow rules in untrusted workspaces", async () => {
    const subject = engine({ trusted: false, rules: [{ kind: "exec", match: ["cargo", "test"], decision: "allow" }] });
    expect((await subject.evaluate(exec("cargo", "test"))).decision).toBe("ask");
  });

  it("suspends exec allow rules after an approved sensitive write", async () => {
    const subject = engine({
      rules: [{ kind: "exec", match: ["pnpm", "test"], decision: "allow" }],
      approver: () => Promise.resolve("allow-once"),
    });
    const verdict = await subject.evaluate(write("packages/a/package.json"));
    expect(verdict).toMatchObject({ decision: "ask", sensitive: true });
    expect((await subject.evaluate(exec("pnpm", "test"))).decision).toBe("allow");
    expect((await subject.authorize(write("packages/a/package.json"))).allowed).toBe(true);
    expect((await subject.evaluate(exec("pnpm", "test"))).decision).toBe("ask");
  });

  it("remembers session approvals as exact argv rules", async () => {
    const subject = engine({ approver: () => Promise.resolve("allow-session") });
    expect((await subject.authorize(exec("cargo", "build"))).allowed).toBe(true);
    expect((await subject.evaluate(exec("cargo", "build"))).decision).toBe("allow");
    expect((await subject.evaluate(exec("cargo", "build", "--release"))).decision).toBe("ask");
  });
});
