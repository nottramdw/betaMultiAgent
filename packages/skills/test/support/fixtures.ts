import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface Workspace {
  readonly base: string;
  readonly root: string;
  readonly config: string;
  cleanup(): Promise<void>;
}

export async function createWorkspace(): Promise<Workspace> {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "bma-skills-")));
  const root = path.join(base, "repo");
  const config = path.join(base, "config");
  await mkdir(root, { recursive: true });
  await mkdir(config, { recursive: true });
  return { base, root, config, cleanup: () => rm(base, { recursive: true, force: true }) };
}

export function skillDocument(name: string, description: string, body = "Instructions."): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
}

export async function writeFileDeep(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
}

export async function writeSkill(
  skillsRoot: string,
  directory: string,
  name: string,
  description = `${name} description`,
  body?: string,
): Promise<string> {
  const dir = path.join(skillsRoot, directory);
  await writeFileDeep(path.join(dir, "SKILL.md"), skillDocument(name, description, body));
  return dir;
}

export async function linkDirectory(target: string, link: string): Promise<void> {
  await mkdir(path.dirname(link), { recursive: true });
  await symlink(target, link, "junction");
}

export async function writePluginManifest(
  pluginDir: string,
  format: ".grok-plugin" | ".cursor-plugin" | ".claude-plugin",
  manifest: unknown,
): Promise<void> {
  await writeFileDeep(path.join(pluginDir, format, "plugin.json"), JSON.stringify(manifest));
}
