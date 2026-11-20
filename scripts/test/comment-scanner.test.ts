import { describe, expect, it } from "vitest";
import { scanFile } from "../lib/comment-scanner.ts";

const lines = (path: string, text: string): number[] => scanFile(path, text).map((finding) => finding.line);

describe("TypeScript and JavaScript", () => {
  it("reports line and block comments with positions", () => {
    const findings = scanFile("a.ts", "const a = 1;\n  // note\nconst b = /* inline */ 2;\n");
    expect(findings.map((finding) => [finding.line, finding.column])).toEqual([
      [2, 3],
      [3, 11],
    ]);
  });

  it("ignores comment markers inside strings, templates and regular expressions", () => {
    const text = [
      'const url = "http://example.com";',
      "const glob = '/* not */';",
      "const template = `// ${String(1)} /* x */`;",
      "const pattern = /\\/\\/.*$/u;",
      "",
    ].join("\n");
    expect(lines("a.ts", text)).toEqual([]);
  });

  it("allows a shebang", () => {
    expect(lines("bin.js", "#!/usr/bin/env node\nimport './main.js';\n")).toEqual([]);
  });

  it("reports comments at end of file", () => {
    expect(lines("a.mjs", "export {};\n// trailing")).toEqual([2]);
  });

  it("rejects JSX sources", () => {
    expect(scanFile("a.tsx", "export {};")[0]?.message).toBe("unsupported source type");
  });
});

describe("Rust", () => {
  it("reports line, doc and nested block comments", () => {
    const text = "fn main() {}\n/// doc\n/* outer /* inner */ still */\nfn f() {}\n";
    expect(lines("a.rs", text)).toEqual([2, 3]);
  });

  it("ignores markers in normal, raw, byte and C strings", () => {
    const text = [
      'let a = "// not";',
      'let b = r#"/* "quoted" */"#;',
      'let c = br"//";',
      'let d = b"/*";',
      'let e = c"//";',
      "let f = b'/';",
      "",
    ].join("\n");
    expect(lines("a.rs", text)).toEqual([]);
  });

  it("distinguishes lifetimes from character literals", () => {
    const text = "fn f<'a>(x: &'a str) -> char { let _ = x; '/' }\nconst Q: char = '\\'';\n// end\n";
    expect(lines("a.rs", text)).toEqual([3]);
  });
});

describe("TOML", () => {
  it("reports comments outside strings", () => {
    const text = [
      "[package]",
      'name = "a#b"',
      "literal = 'c#d'",
      'multi = """',
      "# inside",
      '"""',
      "edition = \"2024\" # trailing",
      "",
    ].join("\n");
    expect(lines("Cargo.toml", text)).toEqual([7]);
  });
});

describe("YAML", () => {
  it("reports comments preceded by whitespace and ignores quoted or embedded hashes", () => {
    const text = [
      "on: push",
      "env:",
      '  A: "x # y"',
      "  B: 'it''s # fine'",
      "  C: a#b",
      "  D: value # trailing",
      "# full line",
      "",
    ].join("\n");
    expect(lines("ci.yml", text)).toEqual([6, 7]);
  });

  it("ignores hashes inside block scalars and resumes after them", () => {
    const text = [
      "jobs:",
      "  build:",
      "    steps:",
      "      - run: |",
      "          # not a comment",
      "",
      "          echo a #b",
      "      - name: x",
      "        run: >-",
      "          # folded",
      "        shell: bash # trailing",
      "      - run: | # header",
      "          x",
      "# after",
      "",
    ].join("\n");
    expect(lines("ci.yml", text)).toEqual([11, 12, 14]);
  });

  it("handles CRLF line endings", () => {
    const text = ["steps:", "  - run: |", "      # x", "  - name: y # z", ""].join("\r\n");
    expect(lines("ci.yml", text)).toEqual([4]);
  });

  it("does not treat a pipe inside a plain value as a block scalar", () => {
    const text = ["a: x | y", "# note", ""].join("\n");
    expect(lines("ci.yml", text)).toEqual([2]);
  });
});

describe("other files", () => {
  it("reports comments in ignore and rc files", () => {
    expect(lines(".gitignore", "dist/\n# note\n")).toEqual([2]);
    expect(lines(".npmrc", "save-exact=true\n; note\n")).toEqual([2]);
  });

  it("rejects JSON with comments and skips generated lockfiles", () => {
    expect(scanFile("a.json", '{ "a": 1 // x\n}')[0]?.message).toBe("not strict JSON");
    expect(lines("pnpm-lock.yaml", "# generated\n")).toEqual([]);
  });

  it("skips unknown file types", () => {
    expect(lines("README.md", "# Title\n")).toEqual([]);
  });
});
