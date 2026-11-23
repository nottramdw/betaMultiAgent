import { TEAM_ROLES, type AgentRole, type ModelRef } from "@betamultiagent/core";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { usageError } from "../cli-error.js";
import { ConfigFileSchema, parseModelSpec, type RoleConfigInput } from "../config/schema.js";
import { modelLabel } from "../judge/model-judge.js";
import { providerRoles, type EvalProvider } from "./eval-estimate.js";

const VARIANT_KEYS = ["roles", "skills"] as const;

const VariantSchema = z.strictObject({
  roles: ConfigFileSchema.shape.roles,
  skills: ConfigFileSchema.shape.skills,
});

export interface EvalVariant {
  readonly name: string;
  readonly file: string;
  readonly sha256: string;
  readonly roles: Readonly<Partial<Record<AgentRole, RoleConfigInput>>>;
  readonly extraRoots: readonly string[];
}

export type EvalRoleConfig = Readonly<Record<AgentRole, RoleConfigInput & { readonly model: string }>>;

function variantName(file: string): string {
  const slug = path
    .basename(file, path.extname(file))
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return slug.length === 0 ? "variant" : slug;
}

export async function loadVariant(file: string): Promise<EvalVariant> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    throw usageError(`cannot read variant ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw usageError(`${file}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw usageError(`${file}: a variant must be a JSON object`);
  }
  const extra = Object.keys(raw).filter((key) => !(VARIANT_KEYS as readonly string[]).includes(key));
  if (extra.length > 0) {
    throw usageError(`${file}: a variant may set only ${VARIANT_KEYS.join(" and ")}; found ${extra.join(", ")}`);
  }
  const parsed = VariantSchema.safeParse(raw);
  if (!parsed.success) {
    throw usageError(`${file}: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")}`);
  }
  return {
    name: variantName(file),
    file,
    sha256: createHash("sha256").update(text).digest("hex"),
    roles: parsed.data.roles ?? {},
    extraRoots: (parsed.data.skills?.extraRoots ?? []).map((root) => path.resolve(path.dirname(file), root)),
  };
}

export function evalRoleConfig(provider: EvalProvider, variant: EvalVariant | undefined): EvalRoleConfig {
  const defaults = providerRoles(provider);
  const entries = TEAM_ROLES.map((role) => [role, { model: modelLabel(defaults[role].model), ...variant?.roles[role] }] as const);
  return Object.fromEntries(entries) as EvalRoleConfig;
}

export function roleModels(config: EvalRoleConfig): Record<AgentRole, ModelRef> {
  return Object.fromEntries(TEAM_ROLES.map((role) => [role, parseModelSpec(config[role].model, config[role].effort)])) as Record<
    AgentRole,
    ModelRef
  >;
}
