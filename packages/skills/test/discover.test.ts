import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverSkills, renderSkillCatalog } from "../src/index.js";
import {
  createWorkspace,
  linkDirectory,
  skillDocument,
  writeFileDeep,
  writePluginManifest,
  writeSkill,
  type Workspace,
} from "./support/fixtures.js";

let workspace: Workspace;

beforeEach(async () => {
  workspace = await createWorkspace();
});

afterEach(async () => {
  await workspace.cleanup();
});

function discover(trusted: boolean) {
  return discoverSkills({ root: workspace.root, userConfigDir: workspace.config, trusted });
}

describe("repo and user sources", () => {
  it("applies repo priority .bma, .claude, .agents and sorts by name", async () => {
    await writeSkill(path.join(workspace.root, ".agents/skills"), "shared", "shared", "from agents");
    await writeSkill(path.join(workspace.root, ".claude/skills"), "shared", "shared", "from claude");
    await writeSkill(path.join(workspace.root, ".bma/skills"), "shared", "shared", "from bma");
    await writeSkill(path.join(workspace.root, ".agents/skills"), "zeta", "zeta");
    await writeSkill(path.join(workspace.config, "skills"), "alpha", "alpha");

    const registry = await discover(true);

    expect(registry.skills.map((skill) => skill.name)).toEqual(["alpha", "shared", "zeta"]);
    expect(registry.find("shared")?.description).toBe("from bma");
    expect(registry.find("shared")?.source).toBe("repo");
    expect(registry.find("alpha")?.source).toBe("user");
    const duplicates = registry.warnings.filter((warning) => warning.includes('duplicate skill "shared"'));
    expect(duplicates).toHaveLength(2);
  });

  it("lets repo skills win over user skills with a warning", async () => {
    await writeSkill(path.join(workspace.root, ".claude/skills"), "build", "build", "repo build");
    await writeSkill(path.join(workspace.config, "skills"), "build", "build", "user build");

    const registry = await discover(true);

    expect(registry.find("build")?.description).toBe("repo build");
    expect(registry.warnings.some((warning) => warning.includes('duplicate skill "build"'))).toBe(true);
  });

  it("drops every repo source when the workspace is untrusted", async () => {
    await writeSkill(path.join(workspace.root, ".bma/skills"), "repo-skill", "repo-skill");
    await writeSkill(path.join(workspace.config, "skills"), "user-skill", "user-skill");
    await writeSkill(path.join(workspace.root, ".bma/plugins/p/skills"), "in-repo-plugin", "in-repo-plugin");
    await writePluginManifest(path.join(workspace.root, ".bma/plugins/p"), ".claude-plugin", { name: "p" });

    const registry = await discover(false);

    expect(registry.skills.map((skill) => skill.name)).toEqual(["user-skill"]);
    expect(registry.warnings).toEqual([]);
  });

  it("never scans plugins placed inside the repo even when trusted", async () => {
    await writeSkill(path.join(workspace.root, ".bma/plugins/p/skills"), "hidden", "hidden");
    await writePluginManifest(path.join(workspace.root, ".bma/plugins/p"), ".claude-plugin", { name: "p" });

    const registry = await discover(true);

    expect(registry.skills).toEqual([]);
    expect(registry.plugins).toEqual([]);
  });

  it("returns an empty registry when nothing exists", async () => {
    const registry = await discoverSkills({
      root: path.join(workspace.base, "missing-root"),
      userConfigDir: path.join(workspace.base, "missing-config"),
      trusted: true,
    });

    expect(registry.skills).toEqual([]);
    expect(registry.readRoots()).toEqual([]);
  });
});

describe("frontmatter validation", () => {
  const skillsRoot = () => path.join(workspace.root, ".bma/skills");

  it("skips missing, malformed and invalid frontmatter with warnings", async () => {
    await writeFileDeep(path.join(skillsRoot(), "no-fence/SKILL.md"), "plain text\n");
    await writeFileDeep(path.join(skillsRoot(), "bad-yaml/SKILL.md"), "---\nname: [unclosed\n---\nbody\n");
    await writeFileDeep(path.join(skillsRoot(), "bad-name/SKILL.md"), skillDocument("Bad_Name", "desc"));
    await writeFileDeep(path.join(skillsRoot(), "no-description/SKILL.md"), "---\nname: nodesc\n---\nbody\n");
    await writeFileDeep(path.join(skillsRoot(), "long-description/SKILL.md"), skillDocument("longdesc", "x".repeat(1025)));
    await writeFileDeep(path.join(skillsRoot(), "empty-fence/SKILL.md"), "---\n---\nbody\n");
    await writeSkill(skillsRoot(), "good", "good");

    const registry = await discover(true);

    expect(registry.skills.map((skill) => skill.name)).toEqual(["good"]);
    expect(registry.warnings).toHaveLength(6);
  });

  it("accepts CRLF documents and extra frontmatter keys", async () => {
    await writeFileDeep(
      path.join(skillsRoot(), "crlf/SKILL.md"),
      "---\r\nname: crlf\r\ndescription: windows file\r\nallowed-tools: Read\r\n---\r\nBody text\r\n",
    );

    const registry = await discover(true);

    expect(registry.find("crlf")?.body).toBe("Body text\r\n");
  });

  it("accepts a description of exactly 1024 characters", async () => {
    await writeFileDeep(path.join(skillsRoot(), "edge/SKILL.md"), skillDocument("edge", "d".repeat(1024)));

    const registry = await discover(true);

    expect(registry.find("edge")?.description).toHaveLength(1024);
  });

  it("rejects SKILL.md files above 64 KiB and accepts the limit", async () => {
    const header = "---\nname: big\ndescription: big skill\n---\n";
    await writeFileDeep(path.join(skillsRoot(), "big/SKILL.md"), header + "a".repeat(64 * 1024 - header.length + 1));
    await writeFileDeep(path.join(skillsRoot(), "exact/SKILL.md"), header.replace("big", "exact") + "a".repeat(64 * 1024 - header.length - 2));

    const registry = await discover(true);

    expect(registry.find("big")).toBeUndefined();
    expect(registry.find("exact")).toBeDefined();
    expect(registry.warnings.some((warning) => warning.includes("exceeds"))).toBe(true);
  });

  it("ignores directories without SKILL.md and loose files silently", async () => {
    await mkdir(path.join(skillsRoot(), "empty-dir"), { recursive: true });
    await writeFile(path.join(skillsRoot(), "README.md"), "docs", "utf8");

    const registry = await discover(true);

    expect(registry.skills).toEqual([]);
    expect(registry.warnings).toEqual([]);
  });
});

describe("link handling", () => {
  it("skips a skill directory that is a symlink or junction", async () => {
    const outside = path.join(workspace.base, "outside");
    await writeSkill(outside, "linked", "linked");
    await linkDirectory(path.join(outside, "linked"), path.join(workspace.root, ".bma/skills/linked"));
    await writeSkill(path.join(workspace.root, ".bma/skills"), "plain", "plain");

    const registry = await discover(true);

    expect(registry.skills.map((skill) => skill.name)).toEqual(["plain"]);
    expect(registry.warnings.some((warning) => warning.includes("symlink or junction"))).toBe(true);
  });

  it("skips a skill root that is a symlink or junction", async () => {
    const outside = path.join(workspace.base, "outside-root");
    await writeSkill(outside, "escaped", "escaped");
    await linkDirectory(outside, path.join(workspace.root, ".claude/skills"));

    const registry = await discover(true);

    expect(registry.skills).toEqual([]);
    expect(registry.warnings.some((warning) => warning.includes("skill root is a symlink or junction"))).toBe(true);
  });

  it("skips a skill root reached through a linked parent directory", async () => {
    const outside = path.join(workspace.base, "outside-parent");
    await writeSkill(path.join(outside, "skills"), "escaped", "escaped");
    await linkDirectory(outside, path.join(workspace.root, ".agents"));

    const registry = await discover(true);

    expect(registry.skills).toEqual([]);
    expect(registry.warnings.length).toBeGreaterThan(0);
  });

  it("skips a SKILL.md that is a symlink", async ({ skip }) => {
    const dir = path.join(workspace.root, ".bma/skills/sneaky");
    await mkdir(dir, { recursive: true });
    const target = path.join(workspace.base, "real-skill.md");
    await writeFile(target, skillDocument("sneaky", "sneaky"), "utf8");
    try {
      await symlink(target, path.join(dir, "SKILL.md"), "file");
    } catch {
      skip("symbolic links are not permitted here");
    }

    const registry = await discover(true);

    expect(registry.find("sneaky")).toBeUndefined();
    expect(registry.warnings.some((warning) => warning.includes("not a regular file"))).toBe(true);
  });
});

describe("plugins", () => {
  const pluginsDir = () => path.join(workspace.config, "plugins");

  it("reads .claude-plugin, .cursor-plugin and .grok-plugin manifests", async () => {
    const formats = [".claude-plugin", ".cursor-plugin", ".grok-plugin"] as const;
    for (const format of formats) {
      const dir = path.join(pluginsDir(), `plugin${format}`);
      await writePluginManifest(dir, format, { name: `p${format.slice(1, 4)}`, version: "1.0.0" });
      await writeSkill(path.join(dir, "skills"), "main", `main${format.slice(1, 4)}`);
    }

    const registry = await discover(false);

    expect(registry.plugins.map((plugin) => plugin.format)).toEqual([".claude-plugin", ".cursor-plugin", ".grok-plugin"]);
    expect(registry.skills.map((skill) => skill.name)).toEqual(["maincla", "maincur", "maingro"]);
    expect(registry.skills.every((skill) => skill.source === "user")).toBe(true);
    expect(registry.plugins[0]?.version).toBe("1.0.0");
  });

  it("prefers .grok-plugin over the other manifests", async () => {
    const dir = path.join(pluginsDir(), "multi");
    await writePluginManifest(dir, ".claude-plugin", { name: "from-claude" });
    await writePluginManifest(dir, ".grok-plugin", { name: "from-grok", skills: "custom" });
    await writeSkill(path.join(dir, "custom"), "one", "one");
    await writeSkill(path.join(dir, "skills"), "two", "two");

    const registry = await discover(false);

    expect(registry.plugins.map((plugin) => plugin.name)).toEqual(["from-grok"]);
    expect(registry.skills.map((skill) => skill.name)).toEqual(["one"]);
  });

  it("supports a skills array and lists unsupported fields", async () => {
    const dir = path.join(pluginsDir(), "rich");
    await writePluginManifest(dir, ".cursor-plugin", {
      name: "rich",
      skills: ["a", "nested/b"],
      hooks: {},
      mcpServers: {},
      extra: 1,
    });
    await writeSkill(path.join(dir, "a"), "one", "one");
    await writeSkill(path.join(dir, "nested/b"), "two", "two");

    const registry = await discover(false);

    expect(registry.skills.map((skill) => skill.name)).toEqual(["one", "two"]);
    expect(registry.plugins[0]?.unsupported).toEqual(["hooks", "mcpServers"]);
    expect(registry.warnings.some((warning) => warning.includes("unsupported fields ignored: hooks, mcpServers"))).toBe(true);
  });

  it("drops a plugin whose skills path escapes the plugin directory", async () => {
    const bad = ["../x", "/abs/path", "C:\\abs", "\\\\server\\share", "a/../../b", "..\\x"];
    for (const [index, value] of bad.entries()) {
      const dir = path.join(pluginsDir(), `bad-${String(index)}`);
      await writePluginManifest(dir, ".claude-plugin", { name: `bad${String(index)}`, skills: [value] });
      await writeSkill(path.join(dir, "skills"), "ok", `ok${String(index)}`);
    }
    await writeSkill(path.join(workspace.config, "x"), "stolen", "stolen");

    const registry = await discover(false);

    expect(registry.plugins).toEqual([]);
    expect(registry.skills).toEqual([]);
    expect(registry.warnings.filter((warning) => warning.includes("not inside the plugin directory"))).toHaveLength(bad.length);
  });

  it("warns for missing, oversized and malformed manifests and skips those plugins", async () => {
    await mkdir(path.join(pluginsDir(), "no-manifest"), { recursive: true });
    await writeFileDeep(path.join(pluginsDir(), "broken/.claude-plugin/plugin.json"), "{ nope");
    await writeFileDeep(
      path.join(pluginsDir(), "huge/.claude-plugin/plugin.json"),
      JSON.stringify({ name: "huge", pad: "a".repeat(1024 * 1024) }),
    );
    await writePluginManifest(path.join(pluginsDir(), "wrong-type"), ".claude-plugin", { skills: 5 });

    const registry = await discover(false);

    expect(registry.plugins).toEqual([]);
    expect(registry.warnings).toHaveLength(4);
  });

  it("falls back to the directory name and ignores wrongly typed optional fields", async () => {
    const dir = path.join(pluginsDir(), "dir-name");
    await writePluginManifest(dir, ".claude-plugin", { name: 7, version: false });
    await writeSkill(path.join(dir, "skills"), "s", "s");

    const registry = await discover(false);

    expect(registry.plugins[0]?.name).toBe("dir-name");
    expect(registry.plugins[0]?.version).toBeUndefined();
    expect(registry.skills).toHaveLength(1);
  });

  it("skips a plugin directory that is a junction", async () => {
    const outside = path.join(workspace.base, "outside-plugin");
    await writePluginManifest(outside, ".claude-plugin", { name: "outside" });
    await writeSkill(path.join(outside, "skills"), "escaped", "escaped");
    await linkDirectory(outside, path.join(pluginsDir(), "linked"));

    const registry = await discover(false);

    expect(registry.skills).toEqual([]);
    expect(registry.warnings.some((warning) => warning.includes("plugin directory is a symlink or junction"))).toBe(true);
  });

  it("ranks user skills above plugin skills", async () => {
    const dir = path.join(pluginsDir(), "p");
    await writePluginManifest(dir, ".claude-plugin", { name: "p" });
    await writeSkill(path.join(dir, "skills"), "same", "same", "from plugin");
    await writeSkill(path.join(workspace.config, "skills"), "same", "same", "from user");

    const registry = await discover(false);

    expect(registry.find("same")?.description).toBe("from user");
    expect(registry.warnings.some((warning) => warning.includes('duplicate skill "same"'))).toBe(true);
  });
});

describe("catalog and read roots", () => {
  it("renders a deterministic catalog across two discoveries", async () => {
    await writeSkill(path.join(workspace.root, ".bma/skills"), "b", "b", "multi   spaced   description");
    await writeSkill(path.join(workspace.config, "skills"), "a", "a", "user skill");
    const plugin = path.join(workspace.config, "plugins/p");
    await writePluginManifest(plugin, ".grok-plugin", { name: "p" });
    await writeSkill(path.join(plugin, "skills"), "c", "c", "plugin skill");

    const first = await discover(true);
    const second = await discover(true);
    const catalog = renderSkillCatalog(first);

    expect(renderSkillCatalog(second)).toBe(catalog);
    expect(first.warnings).toEqual(second.warnings);
    expect(first.readRoots()).toEqual(second.readRoots());
    expect(catalog).toContain("- a (user): user skill");
    expect(catalog).toContain("- b (repo): multi spaced description");
    expect(catalog).toContain("- c (user): plugin skill");
    expect(catalog.indexOf("- a (user)")).toBeLessThan(catalog.indexOf("- b (repo)"));
    expect(catalog).not.toContain(workspace.base);
  });

  it("renders an empty string when there are no skills", async () => {
    expect(renderSkillCatalog(await discover(true))).toBe("");
  });

  it("exposes sorted unique real skill directories as read roots", async () => {
    await writeSkill(path.join(workspace.root, ".bma/skills"), "one", "one");
    await writeSkill(path.join(workspace.config, "skills"), "two", "two");

    const registry = await discover(true);

    expect(registry.readRoots()).toEqual(
      [path.join(workspace.root, ".bma/skills/one"), path.join(workspace.config, "skills/two")].sort(),
    );
  });
});
