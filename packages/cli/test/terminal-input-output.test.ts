import { createRedactor } from "@betamultiagent/core";
import { describe, expect, it } from "vitest";
import { decodePromptBytes } from "../src/input/prompt-file.js";
import { TerminalWriter } from "../src/output/human.js";
import { displayArgv, sanitizeTerminal, truncateDisplay } from "../src/output/sanitize.js";
import { CaptureStream } from "./cli-harness.js";

describe("sanitizeTerminal", () => {
  it("removes escape sequences, control characters and bidi overrides", () => {
    const input = "a\u001b[31mred\u001b[0m\u001b]0;title\u0007b\u001b]8;;http://x\u001b\\link\u0008\r\u009b2Jc‮d⁦e\n\tf";
    expect(sanitizeTerminal(input)).toBe("aredblinkcde\n\tf");
  });

  it("removes device control strings", () => {
    expect(sanitizeTerminal("x\u001bPq#0;2;0;0;0\u001b\\y")).toBe("xy");
  });

  it("keeps ordinary Unicode text", () => {
    expect(sanitizeTerminal("Tiếng Việt ✓ 漢字")).toBe("Tiếng Việt ✓ 漢字");
  });
});

describe("display helpers", () => {
  it("truncates long values with the original length", () => {
    expect(truncateDisplay("x".repeat(300), 10)).toBe(`${"x".repeat(10)}... (300 chars)`);
    expect(displayArgv(["git", "a b"])).toBe('["git","a b"]');
  });
});

describe("TerminalWriter", () => {
  it("redacts secrets before sanitizing", () => {
    const stream = new CaptureStream();
    const writer = new TerminalWriter(stream, createRedactor({ secrets: ["sk-test-secret-value-123"] }));
    writer.line("key=sk-test-secret-value-123 \u001b[2J");
    expect(stream.text).not.toContain("sk-test-secret-value-123");
    expect(stream.text).not.toContain("\u001b");
  });
});

describe("decodePromptBytes", () => {
  it("decodes UTF-8 with and without BOM", () => {
    expect(decodePromptBytes(Buffer.from("xin chào", "utf8"), "f")).toBe("xin chào");
    expect(decodePromptBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hi")]), "f")).toBe("hi");
  });

  it("decodes UTF-16 with a byte order mark", () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("chào", "utf16le")]);
    expect(decodePromptBytes(le, "f")).toBe("chào");
    const body = Buffer.from("chào", "utf16le");
    const swapped = Buffer.alloc(body.length);
    for (let index = 0; index < body.length; index += 2) {
      swapped[index] = body[index + 1] ?? 0;
      swapped[index + 1] = body[index] ?? 0;
    }
    expect(decodePromptBytes(Buffer.concat([Buffer.from([0xfe, 0xff]), swapped]), "f")).toBe("chào");
  });

  it("rejects invalid UTF-8 with an encoding hint", () => {
    expect(() => decodePromptBytes(Buffer.from([0x61, 0xff, 0x62]), "prompt.txt")).toThrow(/utf8/iu);
  });
});
