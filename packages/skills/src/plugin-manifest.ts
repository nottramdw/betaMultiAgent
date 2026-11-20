import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { MANIFEST_LIMIT_BYTES } from "./limits.js";
import { inspectEntry } from "./path-safety.js";
import type { ManifestFormat } from "./types.js";

const MANIFEST_FORMATS: readonly ManifestFormat[] = [".grok-plugin", ".cursor-plugin", ".claude-plugin"];
const UNSUPPORTED_FIELDS = ["hooks", "commands", "agents", "mcpServers", "lspServers"] as const;
export const DEFAULT_SKILLS_PATH = "skills";

const ManifestSchema = z.looseObject({
  name: z.string().optional().catch(undefined),
  version: z.string().optional().catch(undefined),
  description: z.string().optional().catch(undefined),
  skills: z.union([z.string(), z.array(z.string())]).optional(),
});

export interface PluginManifest {
  readonly format: ManifestFormat;
  readonly name: string | undefined;
  readonly version: string | undefined;
  readonly skills: readonly string[];
  readonly unsupported: readonly string[];
}

export type ManifestOutcome =
  | { readonly kind: "loaded"; readonly manifest: PluginManifest }
  | { readonly kind: "absent" }
  | { readonly kind: "invalid"; readonly reason: string };

function normalizeSkills(value: string | readonly string[] | undefined): readonly string[] {
  if (value === undefined) {
    return [DEFAULT_SKILLS_PATH];
  }
  return typeof value === "string" ? [value] : value;
}

export async function readPluginManifest(pluginDir: string): Promise<ManifestOutcome> {
  for (const format of MANIFEST_FORMATS) {
    const file = path.join(pluginDir, format, "plugin.json");
    const entry = await inspectEntry(file);
    if (entry.kind === "missing") {
      continue;
    }
    if (entry.kind !== "file") {
      return { kind: "invalid", reason: `${format}/plugin.json is not a regular file` };
    }
    if (entry.size > MANIFEST_LIMIT_BYTES) {
      return { kind: "invalid", reason: `${format}/plugin.json exceeds ${String(MANIFEST_LIMIT_BYTES)} bytes` };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      return {
        kind: "invalid",
        reason: `${format}/plugin.json is unreadable: ${error instanceof Error ? error.message : "parse error"}`,
      };
    }
    const parsed = ManifestSchema.safeParse(raw);
    if (!parsed.success) {
      return { kind: "invalid", reason: `${format}/plugin.json has an invalid shape: ${parsed.error.message}` };
    }
    const data = parsed.data;
    return {
      kind: "loaded",
      manifest: {
        format,
        name: data.name,
        version: data.version,
        skills: normalizeSkills(data.skills),
        unsupported: UNSUPPORTED_FIELDS.filter((field) => field in data),
      },
    };
  }
  return { kind: "absent" };
}
