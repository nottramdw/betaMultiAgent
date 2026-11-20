import { createRedactor, REDACTED } from "../../src/index.js";
import { describe, expect, it } from "vitest";

describe("createRedactor", () => {
  it("masks registered secrets and known token shapes", () => {
    const redactor = createRedactor({ secrets: ["registered-secret-1"] });
    const input = [
      "a registered-secret-1 b",
      "sk-ant-api03-abcdefghijklmnop",
      "xai-abcdefghijklmnopqrstuvwx",
      "ghp_abcdefghijklmnopqrstuvwxyz0123",
      "github_pat_abcdefghijklmnopqrstuvwxyz_0123",
      "AKIAABCDEFGHIJKLMNOP",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const out = redactor.redact(input);
    expect(out).not.toMatch(/registered-secret-1|sk-ant-api03|xai-abcdef|ghp_abc|github_pat_abc|AKIAABC|MIIE/u);
    expect(out.split(REDACTED)).toHaveLength(8);
  });

  it("ignores secrets shorter than eight characters", () => {
    const redactor = createRedactor({ secrets: ["short", "1234567"] });
    expect(redactor.redact("short 1234567")).toBe("short 1234567");
  });

  it("prefers the longest overlapping secret", () => {
    const redactor = createRedactor({ secrets: ["abcdefgh", "abcdefghijkl"] });
    expect(redactor.redact("xabcdefghijklx")).toBe(`x${REDACTED}x`);
  });

  it("walks nested values", () => {
    const redactor = createRedactor({ secrets: ["nested-secret"] });
    expect(redactor.redactValue({ a: ["nested-secret", 1], b: { c: "nested-secret!" } })).toEqual({
      a: [REDACTED, 1],
      b: { c: `${REDACTED}!` },
    });
  });
});
