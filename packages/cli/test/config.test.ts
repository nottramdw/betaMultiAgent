import path from "node:path";
import { describe, expect, it } from "vitest";
import { CliError, EXIT_USAGE } from "../src/cli-error.js";
import { parseConfigText } from "../src/config/load.js";
import { mergeConfig } from "../src/config/merge.js";
import { passthroughProblem } from "../src/config/passthrough.js";
import { isInsideOrEqual, resolveDirs, resolveWorkspaceRoot } from "../src/config/paths.js";
import { parseModelSpec } from "../src/config/schema.js";
import { configDigest, grantTrust, isTrusted, revokeTrust } from "../src/config/trust.js";
import { makeTempDir, registerCleanup, writeTree } from "./cli-harness.js";

registerCleanup();

function usage(run: () => unknown): CliError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(EXIT_USAGE);
    return error as CliError;
  }
  throw new Error("expected a usage error");
}

describe("resolveDirs", () => {
  it("separates state and configuration under BMA_HOME", () => {
    const dirs = resolveDirs({ BMA_HOME: "/opt/bma" }, "linux", "/home/u");
    expect(dirs).toEqual({ state: "/opt/bma/state", config: "/opt/bma/config", bmaHome: "/opt/bma" });
  });

  it("uses LOCALAPPDATA and APPDATA on Windows", () => {
    const dirs = resolveDirs({ LOCALAPPDATA: "C:\\L", APPDATA: "C:\\R" }, "win32", "C:\\Users\\u");
    expect(dirs.state).toBe("C:\\L\\betaMultiAgent");
    expect(dirs.config).toBe("C:\\R\\betaMultiAgent");
  });

  it("uses Application Support on macOS with separate state and config", () => {
    const dirs = resolveDirs({}, "darwin", "/Users/u");
    expect(dirs.state).not.toBe(dirs.config);
    expect(dirs.state).toBe("/Users/u/Library/Application Support/betaMultiAgent/state");
  });
});

describe("isInsideOrEqual", () => {
  it("folds case on Windows and macOS only", () => {
    expect(isInsideOrEqual("C:\\Repo", "c:\\repo\\src", "win32")).toBe(true);
    expect(isInsideOrEqual("/Repo", "/repo/src", "darwin")).toBe(true);
    expect(isInsideOrEqual("/Repo", "/repo/src", "linux")).toBe(false);
    expect(isInsideOrEqual("/repo", "/repository", "linux")).toBe(false);
  });
});

describe("resolveWorkspaceRoot", () => {
  it("refuses the home directory and directories containing bma state", () => {
    const home = makeTempDir();
    const dirs = resolveDirs({ BMA_HOME: path.join(home, "project", ".bma") }, process.platform, home);
    usage(() => resolveWorkspaceRoot(home, dirs, home, process.platform));
    writeTree(home, { "project/.bma/state/x": "" });
    usage(() => resolveWorkspaceRoot(path.join(home, "project"), dirs, home, process.platform));
  });

  it("refuses a file system root", () => {
    const home = makeTempDir();
    const dirs = resolveDirs({ BMA_HOME: path.join(home, "bma") }, process.platform, home);
    usage(() => resolveWorkspaceRoot(path.parse(home).root, dirs, home, process.platform));
  });
});

describe("parseConfigText", () => {
  it("rejects secret-like keys anywhere in the file", () => {
    const error = usage(() => parseConfigText("bma.config.json", JSON.stringify({ env: { passthrough: [] }, providers: { apiKey: "x" } })));
    expect(error.message).toMatch(/credentials \(\$\.providers\.apiKey\)/u);
  });

  it("rejects unknown fields and invalid JSON", () => {
    usage(() => parseConfigText("bma.config.json", JSON.stringify({ unknown: true })));
    usage(() => parseConfigText("bma.config.json", "{"));
  });

  it("accepts a BOM and validates passthrough names", () => {
    expect(parseConfigText("bma.config.json", `\uFEFF${JSON.stringify({ env: { passthrough: ["JAVA_HOME"] } })}`).env?.passthrough).toEqual([
      "JAVA_HOME",
    ]);
    usage(() => parseConfigText("bma.config.json", JSON.stringify({ env: { passthrough: ["GITHUB_TOKEN"] } })));
  });
});

describe("passthroughProblem", () => {
  it("blocks credential-like and loader variables", () => {
    for (const name of ["ANTHROPIC_API_KEY", "XAI_API_KEY", "NPM_TOKEN", "DB_PASSWORD", "DYLD_INSERT_LIBRARIES", "GIT_CONFIG_GLOBAL", "BMA_HOME", "lower"]) {
      expect(passthroughProblem(name), name).toBeDefined();
    }
    expect(passthroughProblem("JAVA_HOME")).toBeUndefined();
  });
});

describe("parseModelSpec", () => {
  it("parses provider-qualified ids and rejects others", () => {
    expect(parseModelSpec("claude:claude-opus-5-5", "high")).toEqual({ provider: "claude", id: "claude-opus-5-5", effort: "high" });
    expect(parseModelSpec("grok:grok-4.7")).toEqual({ provider: "grok", id: "grok-4.7" });
    usage(() => parseModelSpec("openai:gpt"));
  });
});

describe("mergeConfig", () => {
  const user = parseConfigText("config.json", JSON.stringify({ permissions: { rules: [{ kind: "read", match: "**", decision: "allow" }] }, budget: { maxCostUsd: 5 } }));
  const project = parseConfigText(
    "bma.config.json",
    JSON.stringify({
      roles: { executor: { model: "grok:grok-4.7" } },
      permissions: {
        rules: [
          { kind: "write", match: "src/**", decision: "allow" },
          { kind: "write", match: "dist/**", decision: "deny" },
        ],
      },
      budget: { maxCostUsd: 2 },
      env: { passthrough: ["JAVA_HOME"] },
      skills: { extraRoots: ["/elsewhere"] },
      team: { setup: [["pnpm", "install"]] },
    }),
  );

  it("ignores project allow rules, roles, budget, passthrough and setup when untrusted", () => {
    const merged = mergeConfig(user, project, false);
    expect(merged.rules.map((rule) => rule.decision)).toEqual(["allow", "deny"]);
    expect(merged.rules.some((rule) => rule.kind === "write" && rule.decision === "allow")).toBe(false);
    expect(merged.roles).toEqual({});
    expect(merged.budget.maxCostUsd).toBe(5);
    expect(merged.passthrough).toEqual([]);
    expect(merged.setup).toEqual([]);
    expect(merged.extraSkillRoots).toEqual([]);
    expect(merged.warnings.join("\n")).toMatch(/extraRoots/u);
  });

  it("applies project settings when trusted, keeping the lower budget", () => {
    const merged = mergeConfig(user, project, true);
    expect(merged.rules).toHaveLength(3);
    expect(merged.roles.executor?.model).toBe("grok:grok-4.7");
    expect(merged.budget.maxCostUsd).toBe(2);
    expect(merged.passthrough).toEqual(["JAVA_HOME"]);
    expect(merged.setup).toEqual([["pnpm", "install"]]);
  });

  it("merges role settings field by field, keeping the lower cost cap and treating model and effort as a unit", () => {
    const userRoles = parseConfigText(
      "config.json",
      JSON.stringify({ roles: { executor: { model: "claude:claude-sonnet-5-5", effort: "low", maxCostUsd: 1, instructions: "Be brief." } } }),
    );
    const projectRoles = parseConfigText("bma.config.json", JSON.stringify({ roles: { executor: { model: "grok:grok-4.7", maxCostUsd: 3, maxTurns: 9 } } }));
    expect(mergeConfig(userRoles, projectRoles, true).roles.executor).toEqual({
      model: "grok:grok-4.7",
      instructions: "Be brief.",
      maxTurns: 9,
      maxCostUsd: 1,
    });
    const capOnly = parseConfigText("bma.config.json", JSON.stringify({ roles: { executor: { maxCostUsd: 0.5 } } }));
    expect(mergeConfig(userRoles, capOnly, true).roles.executor).toEqual({
      model: "claude:claude-sonnet-5-5",
      effort: "low",
      instructions: "Be brief.",
      maxCostUsd: 0.5,
    });
    expect(() => parseConfigText("config.json", JSON.stringify({ roles: { executor: { maxCostUsd: 0 } } }))).toThrow();
  });

  it("reads audit retention only from the user configuration", () => {
    expect(mergeConfig(user, project, true).auditRetentionDays).toBe(180);
    const userAudit = parseConfigText("config.json", JSON.stringify({ audit: { retentionDays: 365 } }));
    const projectAudit = parseConfigText("bma.config.json", JSON.stringify({ audit: { retentionDays: 30 } }));
    const merged = mergeConfig(userAudit, projectAudit, true);
    expect(merged.auditRetentionDays).toBe(365);
    expect(merged.warnings.join("\n")).toMatch(/audit is only read from the user configuration/u);
    expect(() => parseConfigText("config.json", JSON.stringify({ audit: { retentionDays: 29 } }))).toThrow();
  });
});

describe("trust store", () => {
  it("binds trust to the config digest and supports revocation", async () => {
    const base = makeTempDir();
    const dirs = resolveDirs({ BMA_HOME: base }, process.platform, base);
    const root = path.join(base, "repo");
    const digest = configDigest(Buffer.from("{}"));
    expect(await isTrusted(dirs, root, digest)).toBe(false);
    await grantTrust(dirs, root, digest, new Date("2026-11-20T00:00:00Z"));
    expect(await isTrusted(dirs, root, digest)).toBe(true);
    expect(await isTrusted(dirs, root, configDigest(Buffer.from("{ }")))).toBe(false);
    expect(await revokeTrust(dirs, root)).toBe(true);
    expect(await revokeTrust(dirs, root)).toBe(false);
    expect(await isTrusted(dirs, root, digest)).toBe(false);
  });

  it("reports a corrupt trust file as a usage error", async () => {
    const base = makeTempDir();
    const dirs = resolveDirs({ BMA_HOME: base }, process.platform, base);
    writeTree(dirs.state, { "trust.json": "not json" });
    await expect(isTrusted(dirs, base, "x")).rejects.toMatchObject({ exitCode: EXIT_USAGE });
  });
});
