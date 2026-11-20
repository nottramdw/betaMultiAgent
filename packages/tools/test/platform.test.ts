import { PathEscapeError } from "@betamultiagent/core";
import { describe, expect, it } from "vitest";
import { assertLexicallySafe } from "../src/platform/path-rules.js";
import { BoundedCapture } from "../src/process/bounded-capture.js";
import { buildChildEnv } from "../src/process/child-env.js";
import { assertCommandLineFits, buildCmdLine, planSpawn } from "../src/process/command-line.js";
import { ExecError } from "../src/process/exec-error.js";

describe("assertLexicallySafe", () => {
  const rejectedOnWindows = [
    "",
    "a\0b",
    "\\\\server\\share\\file",
    "\\\\?\\C:\\secret",
    "\\\\.\\PhysicalDrive0",
    "\\??\\C:\\secret",
    "C:foo",
    "file.txt:stream",
    "dir\\file.txt::$DATA",
    "a<b",
    "a>b",
    "a|b",
    "a?b",
    "a*b",
    'a"b',
    "trailing.",
    "trailing ",
    "dir\\CON",
    "dir\\nul.txt",
    "AUX",
    "com1",
    "LPT9.log",
    "CONIN$",
  ];

  it.each(rejectedOnWindows)("rejects %j on win32", (input) => {
    expect(() => assertLexicallySafe(input, "win32")).toThrow(PathEscapeError);
  });

  it.each(["src/index.ts", "a\\b\\c.txt", "C:\\work\\file.txt", "console.log", "comm"])("accepts %j on win32", (input) => {
    expect(() => assertLexicallySafe(input, "win32")).not.toThrow();
  });

  it("rejects empty and NUL paths on posix", () => {
    expect(() => assertLexicallySafe("", "linux")).toThrow(PathEscapeError);
    expect(() => assertLexicallySafe("a\0b", "linux")).toThrow(PathEscapeError);
  });

  it("allows windows-special characters on posix", () => {
    expect(() => assertLexicallySafe("a:b*c", "linux")).not.toThrow();
  });
});

describe("buildChildEnv", () => {
  const base = {
    PATH: "/bin",
    HOME: "/home/u",
    ANTHROPIC_API_KEY: "secret",
    XAI_API_KEY: "secret",
    GITHUB_TOKEN: "secret",
    CUSTOM: "x",
  };

  it("drops credentials and unknown variables, keeps allowlisted ones", () => {
    const env = buildChildEnv({ baseEnv: base, platform: "linux" });
    expect(env["PATH"]).toBe("/bin");
    expect(env["HOME"]).toBe("/home/u");
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(env["XAI_API_KEY"]).toBeUndefined();
    expect(env["GITHUB_TOKEN"]).toBeUndefined();
    expect(env["CUSTOM"]).toBeUndefined();
  });

  it("never passes ANTHROPIC_ and XAI_ even when requested", () => {
    const env = buildChildEnv({ baseEnv: base, platform: "linux", passthrough: ["ANTHROPIC_API_KEY", "XAI_API_KEY", "CUSTOM"] });
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(env["XAI_API_KEY"]).toBeUndefined();
    expect(env["CUSTOM"]).toBe("x");
  });

  it("sets utf-8 defaults and forced non-interactive git variables", () => {
    const env = buildChildEnv({ baseEnv: base, platform: "linux" });
    expect(env["PYTHONUTF8"]).toBe("1");
    expect(env["PYTHONIOENCODING"]).toBe("utf-8");
    expect(env["GIT_TERMINAL_PROMPT"]).toBe("0");
    expect(env["NO_COLOR"]).toBe("1");
  });

  it("matches names case-insensitively on win32 and keeps the original key", () => {
    const env = buildChildEnv({ baseEnv: { Path: "C:\\bin", anthropic_api_key: "s", SystemRoot: "C:\\Windows" }, platform: "win32" });
    expect(env["Path"]).toBe("C:\\bin");
    expect(Object.keys(env).some((key) => key.toUpperCase() === "ANTHROPIC_API_KEY")).toBe(false);
    expect(env["NoDefaultCurrentDirectoryInExePath"]).toBe("1");
  });
});

describe("command line planning", () => {
  it("passes plain executables through unchanged", () => {
    const plan = planSpawn("/usr/bin/node", ["a.js", "b"], "linux", "");
    expect(plan.file).toBe("/usr/bin/node");
    expect(plan.args).toEqual(["a.js", "b"]);
    expect(plan.viaCmd).toBe(false);
  });

  it("routes cmd shims through cmd.exe on win32", () => {
    const plan = planSpawn("C:\\tools\\npm.cmd", ["install"], "win32", "C:\\Windows");
    expect(plan.viaCmd).toBe(true);
    expect(plan.verbatimArguments).toBe(true);
    expect(plan.file.toLowerCase()).toContain("cmd.exe");
  });

  it.each([[""], ["a b"], ["a&b"], ['a"b'], ["%PATH%"], ["a^b"], ["a|b"], ["a>b"]])("rejects unsafe shim argument %j", (argument) => {
    expect(() => buildCmdLine("C:\\tools\\tool.cmd", [argument])).toThrow(ExecError);
  });

  it("accepts allowlisted shim arguments", () => {
    expect(() => buildCmdLine("C:\\tools\\tool.cmd", ["--flag=1", "dir\\file.txt", "a@b,c:d"])).not.toThrow();
  });

  it("rejects shim paths containing cmd metacharacters", () => {
    expect(() => buildCmdLine("C:\\a&b\\tool.cmd", [])).toThrow(ExecError);
  });

  it("reports command-too-long when the line exceeds the windows limit", () => {
    expect(() => planSpawn("C:\\tools\\node.exe", ["x".repeat(40_000)], "win32", "C:\\Windows")).toThrow(/command line is about/u);
  });

  it("accepts a short command line", () => {
    const plan = planSpawn("C:\\tools\\node.exe", ["x"], "win32", "C:\\Windows");
    expect(() => {
      assertCommandLineFits(plan, "win32");
    }).not.toThrow();
  });
});

describe("BoundedCapture", () => {
  it("keeps small output intact", () => {
    const capture = new BoundedCapture(1024);
    capture.push(Buffer.from("hello "));
    capture.push(Buffer.from("world"));
    expect(capture.truncated).toBe(false);
    expect(capture.text()).toBe("hello world");
  });

  it("keeps head and tail of oversized output and marks truncation", () => {
    const capture = new BoundedCapture(1024);
    capture.push(Buffer.from(`HEAD${"x".repeat(100_000)}TAIL`));
    const text = capture.text();
    expect(capture.truncated).toBe(true);
    expect(text.startsWith("HEAD")).toBe(true);
    expect(text.endsWith("TAIL")).toBe(true);
    expect(text.length).toBeLessThan(2048);
  });
});
