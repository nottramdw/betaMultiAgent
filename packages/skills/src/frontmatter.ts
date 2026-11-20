import { parse } from "yaml";
import { z } from "zod";
import { DESCRIPTION_LIMIT_CHARS, SKILL_NAME_PATTERN } from "./limits.js";

const FrontmatterSchema = z.looseObject({
  name: z.string().regex(SKILL_NAME_PATTERN, "name must match ^[a-z0-9][a-z0-9-]{0,63}$"),
  description: z.string().trim().min(1, "description is empty").max(DESCRIPTION_LIMIT_CHARS, "description is too long"),
});

const FENCE = /^\u{FEFF}?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/u;

export type SkillDocument =
  | { readonly ok: true; readonly name: string; readonly description: string; readonly body: string }
  | { readonly ok: false; readonly reason: string };

export function parseSkillDocument(text: string): SkillDocument {
  const match = FENCE.exec(text);
  if (match === null) {
    return { ok: false, reason: "missing frontmatter" };
  }
  const header = match[1] ?? "";
  let data: unknown;
  try {
    data = parse(header, { maxAliasCount: 0 });
  } catch (error) {
    return { ok: false, reason: `invalid frontmatter YAML: ${error instanceof Error ? error.message : "parse error"}` };
  }
  const result = FrontmatterSchema.safeParse(data);
  if (!result.success) {
    const reason = result.error.issues
      .map((issue) => `${issue.path.map((part) => String(part)).join(".") || "frontmatter"}: ${issue.message}`)
      .join("; ");
    return { ok: false, reason: `invalid frontmatter: ${reason}` };
  }
  return {
    ok: true,
    name: result.data.name,
    description: result.data.description,
    body: text.slice(match[0].length),
  };
}
