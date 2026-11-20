import { realpath } from "node:fs/promises";
import path from "node:path";
import {
  InMemoryFileStateStore,
  PermissionEngine,
  toToolSpec,
  type Environment,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from "@betamultiagent/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSkillTools, discoverSkills, type SkillRegistry } from "../src/index.js";
import { createWorkspace, linkDirectory, writeFileDeep, writeSkill, type Workspace } from "./support/fixtures.js";

let workspace: Workspace;
let registry: SkillRegistry;
let engine: PermissionEngine;
let skillDir: string;

async function resolveForEngine(target: string): Promise<{ requested: string; real: string }> {
  const requested = path.resolve(target);
  return { requested, real: await realpath(requested) };
}

function context(): ToolContext {
  const environment: Environment = {
    id: "test",
    kind: "local",
    root: workspace.root,
    caseSensitive: process.platform === "linux",
    resolvePath: resolveForEngine,
    exec: () => Promise.reject(new Error("exec is not available")),
  };
  return {
    environment,
    signal: new AbortController().signal,
    sessionId: "session",
    agentName: "executor",
    fileState: new InMemoryFileStateStore(),
    depth: 0,
    isPathDenied: (target, mode) => engine.isPathDenied(target, mode),
  };
}

function tool(name: string): ToolDefinition {
  const found = createSkillTools(registry).find((candidate) => candidate.name === name);
  if (found === undefined) {
    throw new Error(`missing tool ${name}`);
  }
  return found;
}

async function run(name: string, input: unknown): Promise<ToolResult> {
  return tool(name).execute(tool(name).input.parse(input), context());
}

beforeEach(async () => {
  workspace = await createWorkspace();
  skillDir = await writeSkill(path.join(workspace.root, ".bma/skills"), "deploy", "deploy", "Deploy helper", "Step one.\nStep two.");
  await writeFileDeep(path.join(skillDir, "notes/guide.md"), "guide text");
  await writeFileDeep(path.join(skillDir, ".env"), "TOKEN=abc");
  await writeFileDeep(path.join(skillDir, "big.txt"), "a".repeat(256 * 1024 + 1));
  await writeFileDeep(path.join(skillDir, "limit.txt"), "a".repeat(256 * 1024));
  await writeFileDeep(path.join(workspace.base, "outside/secret.txt"), "outside secret");
  await linkDirectory(path.join(workspace.base, "outside"), path.join(skillDir, "linked"));
  registry = await discoverSkills({ root: workspace.root, userConfigDir: workspace.config, trusted: true });
  engine = new PermissionEngine({
    root: workspace.root,
    trusted: true,
    permissions: { rules: [], extraReadRoots: [...registry.readRoots()] },
    resolvePath: resolveForEngine,
  });
});

afterEach(async () => {
  await workspace.cleanup();
});

describe("tool definitions", () => {
  it("are read-only with valid specs", () => {
    const tools = createSkillTools(registry);

    expect(tools.map((candidate) => candidate.name)).toEqual(["load_skill", "read_skill_file"]);
    for (const candidate of tools) {
      expect(candidate.capabilities.readOnly).toBe(true);
      expect(() => toToolSpec(candidate)).not.toThrow();
    }
  });
});

describe("load_skill", () => {
  it("returns the body after the frontmatter", async () => {
    const result = await run("load_skill", { name: "deploy" });

    expect(result.isError).toBe(false);
    expect(result.promptText).toBe("Step one.\nStep two.\n");
  });

  it("reports unknown skills as errors", async () => {
    const result = await run("load_skill", { name: "missing" });

    expect(result.isError).toBe(true);
    expect(tool("load_skill").permission({ name: "missing" })).toEqual({ kind: "none" });
  });

  it("requests a read permission on SKILL.md that the engine allows", async () => {
    const request = tool("load_skill").permission({ name: "deploy" });

    expect(request).toEqual({ kind: "read", paths: [path.join(skillDir, "SKILL.md")] });
    expect((await engine.evaluate(request)).decision).toBe("allow");
  });
});

describe("read_skill_file", () => {
  it("reads a file inside the skill directory", async () => {
    const result = await run("read_skill_file", { name: "deploy", path: "notes/guide.md" });

    expect(result).toMatchObject({ isError: false, promptText: "guide text" });
  });

  it("accepts backslash separators", async () => {
    const result = await run("read_skill_file", { name: "deploy", path: "notes\\guide.md" });

    expect(result.isError).toBe(false);
  });

  it("rejects parent traversal and absolute paths", async () => {
    const absolute = path.join(workspace.base, "outside/secret.txt");
    for (const candidate of ["../other/SKILL.md", "notes/../../x", absolute, "/etc/passwd", "C:\\Windows\\win.ini", "\\\\host\\share\\f"]) {
      const result = await run("read_skill_file", { name: "deploy", path: candidate });
      expect(result.isError, candidate).toBe(true);
    }
  });

  it("rejects a path that resolves through a link outside the skill directory", async () => {
    const result = await run("read_skill_file", { name: "deploy", path: "linked/secret.txt" });

    expect(result.isError).toBe(true);
    expect(result.promptText).not.toContain("outside secret");
  });

  it("denies .env inside the skill directory through the permission engine", async () => {
    const request = tool("read_skill_file").permission({ name: "deploy", path: ".env" });
    const verdict = await engine.evaluate(request);
    const result = await run("read_skill_file", { name: "deploy", path: ".env" });

    expect(verdict.decision).toBe("deny");
    expect(result.isError).toBe(true);
    expect(result.promptText).not.toContain("TOKEN");
  });

  it("allows ordinary files through the permission engine", async () => {
    const request = tool("read_skill_file").permission({ name: "deploy", path: "notes/guide.md" });

    expect((await engine.evaluate(request)).decision).toBe("allow");
  });

  it("falls back to the skill directory in the permission request for unsafe paths", () => {
    expect(tool("read_skill_file").permission({ name: "deploy", path: "../x" })).toEqual({ kind: "read", paths: [skillDir] });
    expect(tool("read_skill_file").permission({ name: "nope", path: "x" })).toEqual({ kind: "none" });
  });

  it("enforces the 256 KiB limit", async () => {
    const over = await run("read_skill_file", { name: "deploy", path: "big.txt" });
    const exact = await run("read_skill_file", { name: "deploy", path: "limit.txt" });

    expect(over.isError).toBe(true);
    expect(exact.isError).toBe(false);
  });

  it("reports missing files, directories and unknown skills as errors", async () => {
    expect((await run("read_skill_file", { name: "deploy", path: "nope.md" })).isError).toBe(true);
    expect((await run("read_skill_file", { name: "deploy", path: "notes" })).isError).toBe(true);
    expect((await run("read_skill_file", { name: "unknown", path: "a" })).isError).toBe(true);
  });
});
