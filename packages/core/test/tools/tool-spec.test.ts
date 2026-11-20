import {
  createRedactor,
  defineTool,
  finalizePromptText,
  normalizeJsonSchema,
  SUPPORTED_FORMATS,
  ToolDefinitionError,
  toToolSpec,
  truncateMiddle,
} from "../../src/index.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const ALLOWED_KEYS = new Set([
  "type",
  "properties",
  "required",
  "items",
  "enum",
  "const",
  "anyOf",
  "allOf",
  "$ref",
  "$defs",
  "description",
  "format",
  "additionalProperties",
]);

function visit(node: unknown, onObject: (value: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) {
    node.forEach((inner) => {
      visit(inner, onObject);
    });
    return;
  }
  if (node !== null && typeof node === "object") {
    const record = node as Record<string, unknown>;
    onObject(record);
    for (const [key, value] of Object.entries(record)) {
      if (key === "properties" || key === "$defs") {
        Object.values(value as Record<string, unknown>).forEach((inner) => {
          visit(inner, onObject);
        });
      } else if (key !== "enum" && key !== "const" && key !== "required") {
        visit(value, onObject);
      }
    }
  }
}

const input = z.object({
  path: z.string().min(1).describe("File path"),
  limit: z.number().int().min(1).max(500).optional(),
  mode: z.enum(["text", "json"]),
  email: z.email(),
  tags: z.array(z.string().regex(/^[a-z]+$/u)).min(1),
  nested: z.object({ flag: z.boolean(), when: z.iso.datetime() }),
  choice: z.union([z.object({ kind: z.literal("a"), a: z.string() }), z.object({ kind: z.literal("b"), b: z.number() })]),
  maybe: z.string().nullable(),
});

const spec = toToolSpec({ name: "read_file", description: "Read a file", input });

describe("toToolSpec", () => {
  it("is deterministic", () => {
    expect(JSON.stringify(toToolSpec({ name: "read_file", description: "Read a file", input }))).toBe(
      JSON.stringify(spec),
    );
  });

  it("keeps only the strict subset and closes every object", () => {
    let objects = 0;
    visit(spec.inputSchema, (node) => {
      for (const key of Object.keys(node)) {
        expect(ALLOWED_KEYS.has(key), key).toBe(true);
      }
      if (typeof node["format"] === "string") {
        expect(SUPPORTED_FORMATS.has(node["format"])).toBe(true);
      }
      if (node["type"] === "object") {
        objects += 1;
        expect(node["additionalProperties"]).toBe(false);
      }
    });
    expect(objects).toBeGreaterThanOrEqual(4);
  });

  it("moves dropped constraints into the description", () => {
    const properties = spec.inputSchema["properties"] as Record<string, Record<string, unknown>>;
    expect(properties["path"]?.["description"]).toBe("File path\nConstraints: minLength=1");
    expect(properties["limit"]?.["description"]).toMatch(/^Constraints: .*maximum=500.*minimum=1/u);
    expect(properties["tags"]?.["description"]).toBe("Constraints: minItems=1");
    expect((properties["tags"]?.["items"] as Record<string, unknown>)["description"]).toBe("Constraints: pattern=^[a-z]+$");
    expect(properties["email"]?.["format"]).toBe("email");
    expect(spec.inputSchema["required"]).not.toContain("limit");
  });

  it("downgrades unsupported formats to constraints", () => {
    const out = normalizeJsonSchema(
      { type: "object", properties: { re: { type: "string", format: "regex" } } },
      "demo",
    );
    const properties = out["properties"] as Record<string, Record<string, unknown>>;
    expect(properties["re"]).toEqual({ type: "string", description: "Constraints: format=regex" });
  });

  it("rejects recursive schemas", () => {
    interface Node {
      name: string;
      children: Node[];
    }
    const node: z.ZodType<Node> = z.lazy(() => z.object({ name: z.string(), children: z.array(node) }));
    expect(() => toToolSpec({ name: "tree", description: "", input: z.object({ root: node }) })).toThrow(
      ToolDefinitionError,
    );
  });

  it("rejects open-ended records, non-object roots and invalid names", () => {
    expect(() => toToolSpec({ name: "rec", description: "", input: z.object({ m: z.record(z.string(), z.number()) }) })).toThrow(
      ToolDefinitionError,
    );
    expect(() => toToolSpec({ name: "str", description: "", input: z.string() })).toThrow(ToolDefinitionError);
    expect(() => toToolSpec({ name: "Bad-Name", description: "", input: z.object({}) })).toThrow(ToolDefinitionError);
  });

  it("validates definitions eagerly", () => {
    expect(() =>
      defineTool({
        name: "bad tool",
        description: "",
        input: z.object({}),
        capabilities: { readOnly: true },
        permission: () => ({ kind: "none" }),
        execute: () => Promise.resolve({ output: null, promptText: "", isError: false }),
      }),
    ).toThrow(ToolDefinitionError);
  });
});

describe("prompt text", () => {
  it("keeps head and tail within the byte limit", () => {
    const text = `HEAD${"é".repeat(30_000)}TAIL`;
    const out = truncateMiddle(text, 1024);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(1024);
    expect(out.startsWith("HEAD")).toBe(true);
    expect(out.endsWith("TAIL")).toBe(true);
    expect(out).not.toContain("�");
    expect(out).toMatch(/bytes truncated/u);
  });

  it("returns short text unchanged", () => {
    expect(truncateMiddle("short")).toBe("short");
  });

  it("redacts before truncating", () => {
    const out = finalizePromptText("token=supersecretvalue", createRedactor({ secrets: ["supersecretvalue"] }));
    expect(out).toBe("token=[REDACTED]");
  });
});
