import { chmodSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createDefaultTools,
  createEditFileTool,
  createGlobTool,
  createGrepTool,
  createLocalEnvironment,
  createReadFileTool,
  createWriteFileTool,
} from "../src/index.js";
import { makeContext, makeTempDir, registerCleanup, runTool, writeTree } from "./helpers.js";

registerCleanup();

function setup(files: Record<string, string | Buffer> = {}) {
  const root = makeTempDir();
  writeTree(root, files);
  const environment = createLocalEnvironment({ root });
  return { root, environment, context: makeContext(environment) };
}

describe("read_file", () => {
  it("numbers lines and honours offset and limit", async () => {
    const { context } = setup({ "f.txt": "one\ntwo\nthree\nfour\n" });
    const tool = createReadFileTool();
    const all = await runTool(tool, { path: "f.txt" }, context);
    expect(all.isError).toBe(false);
    expect(all.promptText).toContain("\tone");
    expect(all.promptText).toContain("\tfour");
    const part = await runTool(tool, { path: "f.txt", offset: 2, limit: 2 }, context);
    expect(part.promptText).toContain("\ttwo");
    expect(part.promptText).toContain("\tthree");
    expect(part.promptText).not.toContain("\tone");
    expect(part.promptText).toContain("offset=4");
  });

  it("strips a BOM and handles an empty file", async () => {
    const { context } = setup({ "bom.txt": "﻿hello", "empty.txt": "" });
    const tool = createReadFileTool();
    const bom = await runTool(tool, { path: "bom.txt" }, context);
    expect(bom.promptText).toContain("\thello");
    expect(bom.promptText).not.toContain("﻿");
    const empty = await runTool(tool, { path: "empty.txt" }, context);
    expect(empty.promptText).toBe("(empty file)");
  });

  it("rejects binary files and missing files", async () => {
    const { context } = setup({ "bin.dat": Buffer.from([1, 2, 0, 3]) });
    const tool = createReadFileTool();
    expect((await runTool(tool, { path: "bin.dat" }, context)).isError).toBe(true);
    expect((await runTool(tool, { path: "missing.txt" }, context)).isError).toBe(true);
  });

  it("reports a path escape as a tool error", async () => {
    const { context } = setup();
    const result = await runTool(createReadFileTool(), { path: "../outside.txt" }, context);
    expect(result.isError).toBe(true);
  });

  it("declares the permission request for the path", () => {
    expect(createReadFileTool().permission({ path: "a.txt" })).toMatchObject({ kind: "read", paths: ["a.txt"] });
  });
});

describe("write_file", () => {
  it("creates a file with missing parent directories", async () => {
    const { root, context } = setup();
    const result = await runTool(createWriteFileTool(), { path: "deep/er/new.txt", content: "data" }, context);
    expect(result.isError).toBe(false);
    expect(readFileSync(path.join(root, "deep", "er", "new.txt"), "utf8")).toBe("data");
  });

  it("refuses to overwrite an existing file that was not read", async () => {
    const { root, context } = setup({ "f.txt": "old" });
    const result = await runTool(createWriteFileTool(), { path: "f.txt", content: "new" }, context);
    expect(result.isError).toBe(true);
    expect(readFileSync(path.join(root, "f.txt"), "utf8")).toBe("old");
  });

  it("overwrites after a read and refuses after an external change", async () => {
    const { root, context } = setup({ "f.txt": "old" });
    await runTool(createReadFileTool(), { path: "f.txt" }, context);
    const ok = await runTool(createWriteFileTool(), { path: "f.txt", content: "new" }, context);
    expect(ok.isError).toBe(false);
    expect(readFileSync(path.join(root, "f.txt"), "utf8")).toBe("new");

    writeFileSync(path.join(root, "f.txt"), "changed elsewhere");
    const future = new Date(Date.now() + 60_000);
    utimesSync(path.join(root, "f.txt"), future, future);
    const stale = await runTool(createWriteFileTool(), { path: "f.txt", content: "again" }, context);
    expect(stale.isError).toBe(true);
    expect(readFileSync(path.join(root, "f.txt"), "utf8")).toBe("changed elsewhere");
  });

  it("allows consecutive writes by the same session", async () => {
    const { root, context } = setup();
    const tool = createWriteFileTool();
    expect((await runTool(tool, { path: "n.txt", content: "1" }, context)).isError).toBe(false);
    expect((await runTool(tool, { path: "n.txt", content: "2" }, context)).isError).toBe(false);
    expect(readFileSync(path.join(root, "n.txt"), "utf8")).toBe("2");
  });

  it("leaves no temporary files behind", async () => {
    const { root, context } = setup();
    await runTool(createWriteFileTool(), { path: "clean.txt", content: "x" }, context);
    const listing = await runTool(createGlobTool(), { pattern: "**/*" }, makeContext(createLocalEnvironment({ root })));
    expect(listing.promptText).toBe("clean.txt");
  });

  it("rejects a path outside the workspace", async () => {
    const { context } = setup();
    const result = await runTool(createWriteFileTool(), { path: "../escape.txt", content: "x" }, context);
    expect(result.isError).toBe(true);
  });

  it.skipIf(process.platform === "win32")("preserves the executable bit", async () => {
    const { root, context } = setup({ "run.sh": "#!/bin/sh\n" });
    chmodSync(path.join(root, "run.sh"), 0o755);
    await runTool(createReadFileTool(), { path: "run.sh" }, context);
    await runTool(createWriteFileTool(), { path: "run.sh", content: "#!/bin/sh\necho hi\n" }, context);
    expect(statSync(path.join(root, "run.sh")).mode & 0o111).not.toBe(0);
  });
});

describe("edit_file", () => {
  async function readThen(context: ReturnType<typeof setup>["context"], file: string): Promise<void> {
    await runTool(createReadFileTool(), { path: file }, context);
  }

  it("requires a prior read", async () => {
    const { root, context } = setup({ "f.txt": "alpha" });
    const result = await runTool(createEditFileTool(), { path: "f.txt", old_string: "alpha", new_string: "beta" }, context);
    expect(result.isError).toBe(true);
    expect(readFileSync(path.join(root, "f.txt"), "utf8")).toBe("alpha");
  });

  it("replaces a unique match", async () => {
    const { root, context } = setup({ "f.txt": "alpha beta" });
    await readThen(context, "f.txt");
    const result = await runTool(createEditFileTool(), { path: "f.txt", old_string: "alpha", new_string: "gamma" }, context);
    expect(result.isError).toBe(false);
    expect(readFileSync(path.join(root, "f.txt"), "utf8")).toBe("gamma beta");
  });

  it("rejects a missing and a non-unique match, and supports replace_all", async () => {
    const { root, context } = setup({ "f.txt": "x x x" });
    await readThen(context, "f.txt");
    const tool = createEditFileTool();
    expect((await runTool(tool, { path: "f.txt", old_string: "nope", new_string: "y" }, context)).isError).toBe(true);
    expect((await runTool(tool, { path: "f.txt", old_string: "x", new_string: "y" }, context)).isError).toBe(true);
    const all = await runTool(tool, { path: "f.txt", old_string: "x", new_string: "y", replace_all: true }, context);
    expect(all.isError).toBe(false);
    expect(readFileSync(path.join(root, "f.txt"), "utf8")).toBe("y y y");
  });

  it("refuses when the content changed since the read", async () => {
    const { root, context } = setup({ "f.txt": "alpha" });
    await readThen(context, "f.txt");
    writeFileSync(path.join(root, "f.txt"), "alpha!");
    const result = await runTool(createEditFileTool(), { path: "f.txt", old_string: "alpha", new_string: "beta" }, context);
    expect(result.isError).toBe(true);
    expect(readFileSync(path.join(root, "f.txt"), "utf8")).toBe("alpha!");
  });

  it("preserves CRLF line endings and a BOM", async () => {
    const { root, context } = setup({ "f.txt": "﻿line1\r\nline2\r\n" });
    await readThen(context, "f.txt");
    const result = await runTool(createEditFileTool(), { path: "f.txt", old_string: "line1\nline2", new_string: "a\nb" }, context);
    expect(result.isError).toBe(false);
    expect(readFileSync(path.join(root, "f.txt"), "utf8")).toBe("﻿a\r\nb\r\n");
  });

  it("rejects binary files", async () => {
    const { context } = setup({ "b.dat": Buffer.from([0, 1, 2]) });
    const result = await runTool(createEditFileTool(), { path: "b.dat", old_string: "a", new_string: "b" }, context);
    expect(result.isError).toBe(true);
  });
});

describe("glob", () => {
  const files = {
    "src/a.ts": "",
    "src/b.js": "",
    "src/deep/c.ts": "",
    "node_modules/pkg/index.ts": "",
    ".git/config": "",
    ".env": "SECRET=1",
  };

  it("matches patterns, sorts, and skips .git and node_modules", async () => {
    const { context } = setup(files);
    const result = await runTool(createGlobTool(), { pattern: "**/*.ts" }, context);
    expect(result.promptText.split("\n")).toEqual(["src/a.ts", "src/deep/c.ts"]);
  });

  it("supports a base directory and reports no matches", async () => {
    const { context } = setup(files);
    const scoped = await runTool(createGlobTool(), { pattern: "*.js", path: "src" }, context);
    expect(scoped.promptText).toBe("src/b.js");
    const none = await runTool(createGlobTool(), { pattern: "*.rs" }, context);
    expect(none.promptText).toBe("No files matched.");
  });

  it("omits denied paths", async () => {
    const { environment } = setup(files);
    const context = makeContext(environment, { denied: (target) => path.basename(target) === ".env" });
    const result = await runTool(createGlobTool(), { pattern: "*" }, context);
    expect(result.promptText).not.toContain(".env");
  });

  it("does not follow a symlinked directory outside the root", async () => {
    const outside = makeTempDir();
    writeTree(outside, { "leak.ts": "" });
    const { root, context } = setup({ "in.ts": "" });
    try {
      symlinkSync(outside, path.join(root, "out"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      return;
    }
    const result = await runTool(createGlobTool(), { pattern: "**/*.ts" }, context);
    expect(result.promptText).toBe("in.ts");
  });

  it("limits the result count", async () => {
    const many: Record<string, string> = {};
    for (let index = 0; index < 1100; index += 1) {
      many[`f/${String(index).padStart(4, "0")}.txt`] = "";
    }
    const { context } = setup(many);
    const result = await runTool(createGlobTool(), { pattern: "**/*.txt" }, context);
    expect(result.promptText).toContain("[results limited to 1000 entries]");
  });
});

describe("grep", () => {
  const files = {
    "a.txt": "hello world\nsecond line\nHello again\n",
    "sub/b.txt": "nothing here\nhello sub\n",
    "bin.dat": Buffer.from([104, 101, 108, 108, 111, 0, 1]),
    "node_modules/m.txt": "hello module\n",
    ".env": "hello secret\n",
  };

  it("finds matches with file and line", async () => {
    const { context } = setup(files);
    const result = await runTool(createGrepTool(), { pattern: "hello" }, context);
    expect(result.isError).toBe(false);
    expect(result.promptText).toContain("a.txt:1: hello world");
    expect(result.promptText).toContain("sub/b.txt:2: hello sub");
    expect(result.promptText).not.toContain("node_modules");
    expect(result.promptText).toContain("1 binary");
  });

  it("supports ignoreCase, glob and maxResults", async () => {
    const { context } = setup(files);
    const tool = createGrepTool();
    const insensitive = await runTool(tool, { pattern: "hello", ignoreCase: true, glob: "a.txt" }, context);
    expect(insensitive.promptText).toContain("a.txt:3: Hello again");
    const limited = await runTool(tool, { pattern: "hello", ignoreCase: true, maxResults: 1 }, context);
    expect(limited.promptText).toContain("1 match(es)");
    expect(limited.promptText).toContain("truncated");
  });

  it("searches a single file", async () => {
    const { context } = setup(files);
    const result = await runTool(createGrepTool(), { pattern: "second", path: "a.txt" }, context);
    expect(result.promptText).toContain("a.txt:2: second line");
  });

  it("rejects an invalid regular expression", async () => {
    const { context } = setup(files);
    const result = await runTool(createGrepTool(), { pattern: "(" }, context);
    expect(result.isError).toBe(true);
    expect(result.promptText).toContain("invalid regular expression");
  });

  it("skips denied files and counts them", async () => {
    const { environment } = setup(files);
    const context = makeContext(environment, { denied: (target) => path.basename(target) === ".env" });
    const result = await runTool(createGrepTool(), { pattern: "secret" }, context);
    expect(result.promptText).not.toContain(".env:");
    expect(result.promptText).toContain("1 denied");
  });

  it("stops a catastrophic pattern within the timeout", async () => {
    const { context } = setup({ "evil.txt": `${"a".repeat(60)}!\n` });
    const started = Date.now();
    const result = await runTool(createGrepTool({ timeoutMs: 800 }), { pattern: "^(a+)+$" }, context);
    expect(result.isError).toBe(true);
    expect(result.promptText).toContain("catastrophic backtracking");
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);

  it("reports cancellation", async () => {
    const { environment } = setup({ "evil.txt": `${"a".repeat(60)}!\n` });
    const controller = new AbortController();
    const context = makeContext(environment, { signal: controller.signal });
    const pending = runTool(createGrepTool({ timeoutMs: 20_000 }), { pattern: "^(a+)+$" }, context);
    setTimeout(() => {
      controller.abort();
    }, 300);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.promptText).toContain("cancelled");
  }, 30_000);
});

describe("createDefaultTools", () => {
  it("returns the six built-in tools sorted by name with correct capabilities", () => {
    const { environment } = setup();
    const tools = createDefaultTools({ environment });
    expect(tools.map((tool) => tool.name)).toEqual(["edit_file", "glob", "grep", "read_file", "run_command", "write_file"]);
    const readOnly = Object.fromEntries(tools.map((tool) => [tool.name, tool.capabilities.readOnly]));
    expect(readOnly).toEqual({
      edit_file: false,
      glob: true,
      grep: true,
      read_file: true,
      run_command: false,
      write_file: false,
    });
    expect(tools.find((tool) => tool.name === "run_command")?.capabilities.exclusive).toBe(true);
  });
});

describe("run_command", () => {
  it("runs through the environment and flags non-zero exits as errors", async () => {
    const { environment, context } = setup();
    const tool = createDefaultTools({ environment }).find((candidate) => candidate.name === "run_command");
    expect(tool).toBeDefined();
    const ok = await tool?.execute({ argv: ["node", "-e", "process.stdout.write('hi')"] }, context);
    expect(ok?.isError).toBe(false);
    expect(ok?.promptText).toContain("hi");
    const failed = await tool?.execute({ argv: ["node", "-e", "process.exit(2)"] }, context);
    expect(failed?.isError).toBe(true);
    expect(failed?.promptText).toContain("exit code: 2");
  });

  it("converts an unknown command into a tool error", async () => {
    const { environment, context } = setup();
    const tool = createDefaultTools({ environment }).find((candidate) => candidate.name === "run_command");
    const result = await tool?.execute({ argv: ["definitely-not-a-real-command-xyz"] }, context);
    expect(result?.isError).toBe(true);
  });

  it("builds an exec permission request with an absolute cwd", () => {
    const { environment } = setup();
    const tool = createDefaultTools({ environment }).find((candidate) => candidate.name === "run_command");
    const request = tool?.permission({ argv: ["node", "-v"], cwd: "src" });
    expect(request).toMatchObject({ kind: "exec", argv: ["node", "-v"], cwd: path.resolve(environment.root, "src") });
  });
});
