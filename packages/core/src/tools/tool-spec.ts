import { z } from "zod";

export type JsonSchema = { readonly [key: string]: unknown };

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;

export const SUPPORTED_FORMATS: ReadonlySet<string> = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);

const KEYWORD_ORDER = [
  "type",
  "description",
  "format",
  "enum",
  "const",
  "properties",
  "required",
  "items",
  "anyOf",
  "allOf",
  "$ref",
  "$defs",
] as const;

const DROPPED_SILENTLY: ReadonlySet<string> = new Set(["$schema", "$id", "title"]);

export class ToolDefinitionError extends Error {
  readonly toolName: string;

  constructor(toolName: string, message: string) {
    super(`tool ${toolName}: ${message}`);
    this.name = "ToolDefinitionError";
    this.toolName = toolName;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function describeConstraint(key: string, value: unknown): string {
  return `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`;
}

function isObjectSchema(schema: Record<string, unknown>): boolean {
  const type = schema["type"];
  return type === "object" || (Array.isArray(type) && type.includes("object")) || isRecord(schema["properties"]);
}

function normalizeNode(node: unknown, toolName: string): JsonSchema {
  if (!isRecord(node)) {
    throw new ToolDefinitionError(toolName, "schema node is not an object");
  }
  const source: Record<string, unknown> = { ...node };
  if (source["oneOf"] !== undefined && source["anyOf"] === undefined) {
    source["anyOf"] = source["oneOf"];
    delete source["oneOf"];
  }
  const constraints: string[] = [];
  const kept: Record<string, unknown> = {};

  for (const key of Object.keys(source).sort()) {
    const value = source[key];
    if (DROPPED_SILENTLY.has(key)) {
      continue;
    }
    switch (key) {
      case "additionalProperties":
        if (isRecord(value) && Object.keys(value).length > 0) {
          throw new ToolDefinitionError(toolName, "objects with open-ended keys are not supported");
        }
        break;
      case "type":
      case "description":
      case "enum":
      case "const":
      case "required":
      case "$ref":
        kept[key] = value;
        break;
      case "format":
        if (typeof value === "string" && SUPPORTED_FORMATS.has(value)) {
          kept[key] = value;
        } else {
          constraints.push(describeConstraint(key, value));
        }
        break;
      case "properties":
        if (!isRecord(value)) {
          throw new ToolDefinitionError(toolName, "properties must be an object");
        }
        kept[key] = Object.fromEntries(
          Object.entries(value).map(([name, inner]) => [name, normalizeNode(inner, toolName)]),
        );
        break;
      case "items":
        if (Array.isArray(value)) {
          constraints.push(describeConstraint(key, value));
        } else {
          kept[key] = normalizeNode(value, toolName);
        }
        break;
      case "anyOf":
      case "allOf":
        if (!Array.isArray(value)) {
          throw new ToolDefinitionError(toolName, `${key} must be an array`);
        }
        kept[key] = value.map((inner) => normalizeNode(inner, toolName));
        break;
      case "$defs":
        if (!isRecord(value)) {
          throw new ToolDefinitionError(toolName, "$defs must be an object");
        }
        kept[key] = Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((name) => [name, normalizeNode(value[name], toolName)]),
        );
        break;
      default:
        constraints.push(describeConstraint(key, value));
    }
  }

  if (constraints.length > 0) {
    const note = `Constraints: ${constraints.join("; ")}`;
    const existing = kept["description"];
    kept["description"] = typeof existing === "string" && existing.length > 0 ? `${existing}\n${note}` : note;
  }

  const out: Record<string, unknown> = {};
  for (const key of KEYWORD_ORDER) {
    if (kept[key] !== undefined) {
      out[key] = kept[key];
    }
  }
  if (isObjectSchema(out)) {
    out["additionalProperties"] = false;
  }
  return out;
}

function collectRefs(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const inner of node) {
      collectRefs(inner, into);
    }
    return;
  }
  if (!isRecord(node)) {
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && typeof value === "string") {
      into.add(value);
    } else if (key !== "$defs") {
      collectRefs(value, into);
    }
  }
}

function defName(ref: string): string | undefined {
  const match = /^#\/\$defs\/(.+)$/u.exec(ref);
  return match?.[1];
}

function assertNotRecursive(schema: Record<string, unknown>, toolName: string): void {
  const defs = isRecord(schema["$defs"]) ? schema["$defs"] : {};
  const edges = new Map<string, Set<string>>();
  const rootRefs = new Set<string>();
  collectRefs(schema, rootRefs);
  for (const [name, def] of Object.entries(defs)) {
    const refs = new Set<string>();
    collectRefs(def, refs);
    edges.set(name, refs);
  }
  const all = [rootRefs, ...edges.values()];
  if (all.some((refs) => refs.has("#"))) {
    throw new ToolDefinitionError(toolName, "recursive schemas are not supported");
  }
  const state = new Map<string, "visiting" | "done">();
  const visit = (name: string): void => {
    const current = state.get(name);
    if (current === "done") {
      return;
    }
    if (current === "visiting") {
      throw new ToolDefinitionError(toolName, "recursive schemas are not supported");
    }
    state.set(name, "visiting");
    for (const ref of edges.get(name) ?? []) {
      const target = defName(ref);
      if (target === undefined) {
        throw new ToolDefinitionError(toolName, `unsupported $ref ${ref}`);
      }
      visit(target);
    }
    state.set(name, "done");
  };
  for (const ref of rootRefs) {
    const target = defName(ref);
    if (target === undefined) {
      throw new ToolDefinitionError(toolName, `unsupported $ref ${ref}`);
    }
    visit(target);
  }
}

export function normalizeJsonSchema(schema: unknown, toolName: string): JsonSchema {
  if (!isRecord(schema)) {
    throw new ToolDefinitionError(toolName, "input schema must be an object");
  }
  assertNotRecursive(schema, toolName);
  const normalized = normalizeNode(schema, toolName);
  if (normalized["type"] !== "object") {
    throw new ToolDefinitionError(toolName, "input schema must describe an object");
  }
  return normalized;
}

export interface ToolSpecSource {
  readonly name: string;
  readonly description: string;
  readonly input: z.ZodType;
}

export function toToolSpec(tool: ToolSpecSource): ToolSpec {
  if (!TOOL_NAME_PATTERN.test(tool.name)) {
    throw new ToolDefinitionError(tool.name, `name must match ${TOOL_NAME_PATTERN.source}`);
  }
  let raw: unknown;
  try {
    raw = z.toJSONSchema(tool.input, { io: "input", target: "draft-2020-12" });
  } catch (error) {
    throw new ToolDefinitionError(tool.name, `input schema is not representable: ${String(error)}`);
  }
  return { name: tool.name, description: tool.description, inputSchema: normalizeJsonSchema(raw, tool.name) };
}
