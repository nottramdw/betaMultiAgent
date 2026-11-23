import { cp, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverSkills, renderSkillCatalog } from "../src/index.js";
import { SKILL_FILE_LIMIT_BYTES } from "../src/limits.js";
import { createWorkspace, type Workspace } from "./support/fixtures.js";

const PLUGIN = fileURLToPath(new URL("../../../plugins/bma-method", import.meta.url));

const EXPECTED = [
  "bma-benchmark-checklist",
  "bma-create-verification-skill",
  "bma-design-boundaries",
  "bma-encode-correction",
  "bma-explain-mechanics",
  "bma-explain-rationale",
  "bma-teach-codebase",
  "bma-working-principles",
];

let workspace: Workspace;

beforeEach(async () => {
  workspace = await createWorkspace();
});

afterEach(async () => {
  await workspace.cleanup();
});

describe("method skill plugin", () => {
  it("loads all skills from the user plugins directory without warnings", async () => {
    await cp(PLUGIN, path.join(workspace.config, "plugins", "bma-method"), { recursive: true });

    const registry = await discoverSkills({ root: workspace.root, userConfigDir: workspace.config, trusted: false });

    expect(registry.warnings).toEqual([]);
    expect(registry.plugins.map((plugin) => plugin.name)).toEqual(["bma-method"]);
    expect(registry.plugins[0]?.unsupported).toEqual([]);
    expect(registry.skills.map((skill) => skill.name)).toEqual(EXPECTED);
    expect(registry.skills.every((skill) => skill.origin === "plugin:bma-method")).toBe(true);
    const catalog = renderSkillCatalog(registry);
    for (const name of EXPECTED) {
      expect(catalog).toContain(`- ${name} (user): `);
    }
  });

  it("loads all skills through an absolute extra root", async () => {
    const registry = await discoverSkills({
      root: workspace.root,
      userConfigDir: workspace.config,
      trusted: false,
      extraRoots: [path.join(PLUGIN, "skills")],
    });

    expect(registry.warnings).toEqual([]);
    expect(registry.plugins).toEqual([]);
    expect(registry.skills.map((skill) => skill.name)).toEqual(EXPECTED);
  });

  it("keeps each skill a single file under the size limit whose name matches its directory", async () => {
    const directories = (await readdir(path.join(PLUGIN, "skills"))).sort();
    expect(directories).toEqual(EXPECTED);
    for (const directory of directories) {
      const entries = await readdir(path.join(PLUGIN, "skills", directory));
      expect(entries).toEqual(["SKILL.md"]);
      const text = await readFile(path.join(PLUGIN, "skills", directory, "SKILL.md"), "utf8");
      expect(Buffer.byteLength(text, "utf8")).toBeLessThan(SKILL_FILE_LIMIT_BYTES);
      expect(text).toContain(`\nname: ${directory}\n`);
    }
  });
});
