import { readFile, realpath, stat } from "node:fs/promises";
import { defineTool, type PermissionRequest, type ToolContext, type ToolDefinition, type ToolResult } from "@betamultiagent/core";
import { z } from "zod";
import { SKILL_ASSET_LIMIT_BYTES } from "./limits.js";
import { isInside, isSafeRelativePath, joinRelative } from "./path-safety.js";
import type { SkillRegistry } from "./types.js";

const LoadSkillInput = z.object({
  name: z.string().min(1).max(64).describe("Skill name from the skill catalog."),
});

const ReadSkillFileInput = z.object({
  name: z.string().min(1).max(64).describe("Skill name from the skill catalog."),
  path: z.string().min(1).max(1024).describe("Relative path of a file inside the skill directory."),
});

function failure(message: string): ToolResult<string> {
  return { output: message, promptText: message, isError: true };
}

function success(text: string): ToolResult<string> {
  return { output: text, promptText: text, isError: false };
}

function loadSkillTool(registry: SkillRegistry): ToolDefinition<z.infer<typeof LoadSkillInput>, string> {
  return defineTool({
    name: "load_skill",
    description: "Load the instructions of a skill from the skill catalog. Returns the SKILL.md content after its frontmatter.",
    input: LoadSkillInput,
    capabilities: { readOnly: true },
    permission: (input): PermissionRequest => {
      const skill = registry.find(input.name);
      return skill === undefined ? { kind: "none" } : { kind: "read", paths: [skill.file] };
    },
    execute: (input) => {
      const skill = registry.find(input.name);
      return Promise.resolve(skill === undefined ? failure(`unknown skill: ${input.name}`) : success(skill.body));
    },
  });
}

async function readAsset(
  registry: SkillRegistry,
  input: z.infer<typeof ReadSkillFileInput>,
  context: ToolContext,
): Promise<ToolResult<string>> {
  const skill = registry.find(input.name);
  if (skill === undefined) {
    return failure(`unknown skill: ${input.name}`);
  }
  if (!isSafeRelativePath(input.path)) {
    return failure("path must be relative and stay inside the skill directory");
  }
  const target = joinRelative(skill.dir, input.path);
  let real: string;
  try {
    real = await realpath(target);
  } catch {
    return failure(`file not found: ${input.path}`);
  }
  if (!isInside(skill.dir, real)) {
    return failure("path resolves outside the skill directory");
  }
  if ((await context.isPathDenied(target, "read")) || (await context.isPathDenied(real, "read"))) {
    return failure(`read denied by permission policy: ${input.path}`);
  }
  try {
    const info = await stat(real);
    if (!info.isFile()) {
      return failure(`not a regular file: ${input.path}`);
    }
    if (info.size > SKILL_ASSET_LIMIT_BYTES) {
      return failure(`file exceeds ${String(SKILL_ASSET_LIMIT_BYTES)} bytes: ${input.path}`);
    }
    return success(await readFile(real, "utf8"));
  } catch (error) {
    return failure(`cannot read ${input.path}: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

function readSkillFileTool(registry: SkillRegistry): ToolDefinition<z.infer<typeof ReadSkillFileInput>, string> {
  return defineTool({
    name: "read_skill_file",
    description: "Read a supporting file that belongs to a skill, addressed by a path relative to the skill directory.",
    input: ReadSkillFileInput,
    capabilities: { readOnly: true },
    permission: (input): PermissionRequest => {
      const skill = registry.find(input.name);
      if (skill === undefined) {
        return { kind: "none" };
      }
      const paths = isSafeRelativePath(input.path) ? [joinRelative(skill.dir, input.path)] : [skill.dir];
      return { kind: "read", paths };
    },
    execute: (input, context) => readAsset(registry, input, context),
  });
}

export function createSkillTools(registry: SkillRegistry): readonly ToolDefinition[] {
  return [loadSkillTool(registry), readSkillFileTool(registry)];
}
