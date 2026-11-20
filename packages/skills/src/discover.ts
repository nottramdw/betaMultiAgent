import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parseSkillDocument } from "./frontmatter.js";
import { SKILL_FILE_LIMIT_BYTES, SKILL_FILE_NAME } from "./limits.js";
import {
  compareText,
  inspectEntry,
  isGenuineLocation,
  isSafeRelativePath,
  joinRelative,
  resolveReal,
} from "./path-safety.js";
import { readPluginManifest } from "./plugin-manifest.js";
import type { DiscoverOptions, PluginSummary, Skill, SkillRegistry, SkillSource } from "./types.js";

const REPO_SKILL_DIRS: readonly string[] = [".bma/skills", ".claude/skills", ".agents/skills"];

interface Collector {
  readonly warnings: string[];
}

async function listNames(dir: string, collector: Collector): Promise<readonly string[]> {
  try {
    return (await readdir(dir)).sort(compareText);
  } catch (error) {
    collector.warnings.push(`${dir}: cannot list directory (${error instanceof Error ? error.message : "unknown error"})`);
    return [];
  }
}

async function loadSkill(
  dir: string,
  source: SkillSource,
  origin: string,
  collector: Collector,
): Promise<Skill | undefined> {
  const entry = await inspectEntry(dir);
  if (entry.kind === "symlink") {
    collector.warnings.push(`${dir}: skill directory is a symlink or junction, skipped`);
    return undefined;
  }
  if (entry.kind !== "directory") {
    return undefined;
  }
  const file = path.join(dir, SKILL_FILE_NAME);
  const fileEntry = await inspectEntry(file);
  if (fileEntry.kind === "missing") {
    return undefined;
  }
  if (fileEntry.kind !== "file") {
    collector.warnings.push(`${file}: not a regular file, skipped`);
    return undefined;
  }
  if (fileEntry.size > SKILL_FILE_LIMIT_BYTES) {
    collector.warnings.push(`${file}: exceeds ${String(SKILL_FILE_LIMIT_BYTES)} bytes, skipped`);
    return undefined;
  }
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    collector.warnings.push(`${file}: unreadable (${error instanceof Error ? error.message : "unknown error"})`);
    return undefined;
  }
  const document = parseSkillDocument(text);
  if (!document.ok) {
    collector.warnings.push(`${file}: ${document.reason}, skipped`);
    return undefined;
  }
  return { name: document.name, description: document.description, source, origin, dir, file, body: document.body };
}

async function scanSkillRoot(
  dir: string,
  source: SkillSource,
  origin: string,
  collector: Collector,
): Promise<readonly Skill[]> {
  const entry = await inspectEntry(dir);
  if (entry.kind === "missing") {
    return [];
  }
  if (entry.kind === "symlink") {
    collector.warnings.push(`${dir}: skill root is a symlink or junction, skipped`);
    return [];
  }
  if (entry.kind !== "directory") {
    return [];
  }
  if (!(await isGenuineLocation(dir))) {
    collector.warnings.push(`${dir}: skill root resolves through a link, skipped`);
    return [];
  }
  const skills: Skill[] = [];
  for (const name of await listNames(dir, collector)) {
    const skill = await loadSkill(path.join(dir, name), source, origin, collector);
    if (skill !== undefined) {
      skills.push(skill);
    }
  }
  return skills;
}

async function scanPlugin(
  pluginDir: string,
  directoryName: string,
  collector: Collector,
): Promise<{ readonly summary: PluginSummary; readonly skills: readonly Skill[] } | undefined> {
  const entry = await inspectEntry(pluginDir);
  if (entry.kind === "symlink") {
    collector.warnings.push(`${pluginDir}: plugin directory is a symlink or junction, skipped`);
    return undefined;
  }
  if (entry.kind !== "directory") {
    return undefined;
  }
  const outcome = await readPluginManifest(pluginDir);
  if (outcome.kind === "absent") {
    collector.warnings.push(`${pluginDir}: no plugin manifest found, skipped`);
    return undefined;
  }
  if (outcome.kind === "invalid") {
    collector.warnings.push(`${pluginDir}: ${outcome.reason}, skipped`);
    return undefined;
  }
  const manifest = outcome.manifest;
  const name = manifest.name ?? directoryName;
  const unsafe = manifest.skills.find((value) => !isSafeRelativePath(value));
  if (unsafe !== undefined) {
    collector.warnings.push(`plugin ${name}: skills path "${unsafe}" is not inside the plugin directory, plugin skipped`);
    return undefined;
  }
  if (manifest.unsupported.length > 0) {
    collector.warnings.push(`plugin ${name}: unsupported fields ignored: ${manifest.unsupported.join(", ")}`);
  }
  const skills: Skill[] = [];
  for (const relative of manifest.skills) {
    skills.push(...(await scanSkillRoot(joinRelative(pluginDir, relative), "user", `plugin:${name}`, collector)));
  }
  return {
    summary: { name, directory: pluginDir, format: manifest.format, version: manifest.version, unsupported: manifest.unsupported },
    skills,
  };
}

async function scanPlugins(
  pluginsDir: string,
  collector: Collector,
): Promise<{ readonly plugins: readonly PluginSummary[]; readonly skills: readonly Skill[] }> {
  const entry = await inspectEntry(pluginsDir);
  if (entry.kind === "missing") {
    return { plugins: [], skills: [] };
  }
  if (entry.kind !== "directory" || !(await isGenuineLocation(pluginsDir))) {
    collector.warnings.push(`${pluginsDir}: plugins directory is not a plain directory, skipped`);
    return { plugins: [], skills: [] };
  }
  const plugins: PluginSummary[] = [];
  const skills: Skill[] = [];
  for (const name of await listNames(pluginsDir, collector)) {
    const result = await scanPlugin(path.join(pluginsDir, name), name, collector);
    if (result !== undefined) {
      plugins.push(result.summary);
      skills.push(...result.skills);
    }
  }
  return { plugins, skills };
}

function buildRegistry(
  candidates: readonly Skill[],
  plugins: readonly PluginSummary[],
  warnings: readonly string[],
): SkillRegistry {
  const winners = new Map<string, Skill>();
  const all = [...warnings];
  for (const skill of candidates) {
    const existing = winners.get(skill.name);
    if (existing === undefined) {
      winners.set(skill.name, skill);
    } else {
      all.push(`duplicate skill "${skill.name}": ${skill.dir} is shadowed by ${existing.dir}`);
    }
  }
  const skills = [...winners.values()].sort((a, b) => compareText(a.name, b.name));
  const roots = [...new Set(skills.map((skill) => skill.dir))].sort(compareText);
  return {
    skills,
    plugins,
    warnings: all,
    find: (name) => winners.get(name),
    readRoots: () => roots,
  };
}

export async function discoverSkills(options: DiscoverOptions): Promise<SkillRegistry> {
  const collector: Collector = { warnings: [] };
  const candidates: Skill[] = [];
  const plugins: PluginSummary[] = [];

  if (options.trusted) {
    const realRoot = await resolveReal(options.root);
    if (realRoot === undefined) {
      collector.warnings.push(`${options.root}: workspace root cannot be resolved, repo skills skipped`);
    } else {
      for (const relative of REPO_SKILL_DIRS) {
        candidates.push(...(await scanSkillRoot(joinRelative(realRoot, relative), "repo", relative, collector)));
      }
    }
  }

  const realConfig = await resolveReal(options.userConfigDir);
  if (realConfig !== undefined) {
    candidates.push(...(await scanSkillRoot(path.join(realConfig, "skills"), "user", "skills", collector)));
    const found = await scanPlugins(path.join(realConfig, "plugins"), collector);
    plugins.push(...found.plugins);
    candidates.push(...found.skills);
  }

  for (const extra of options.extraRoots ?? []) {
    if (!path.isAbsolute(extra)) {
      collector.warnings.push(`${extra}: extra skill root must be an absolute path, skipped`);
      continue;
    }
    candidates.push(...(await scanSkillRoot(path.resolve(extra), "user", extra, collector)));
  }

  return buildRegistry(candidates, plugins, collector.warnings);
}
