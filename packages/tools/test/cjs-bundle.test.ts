import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { makeTempDir, registerCleanup, writeTree } from "./helpers.js";

registerCleanup();

const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/index.ts");

describe("commonjs bundle", () => {
  it("runs the grep worker and file tools from a single CommonJS file", async () => {
    const out = makeTempDir("bma-bundle-");
    const bundle = path.join(out, "tools.cjs");
    await build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22",
      conditions: ["source"],
      outfile: bundle,
      logLevel: "silent",
    });
    const workspace = makeTempDir("bma-ws-");
    writeTree(workspace, { "a.txt": "needle in haystack\nother\n", "sub/b.txt": "no match\nneedle again\n" });
    const runner = path.join(out, "run.cjs");
    writeFileSync(
      runner,
      [
        "const tools = require(process.argv[2]);",
        "const environment = tools.createLocalEnvironment({ root: process.argv[3] });",
        "const grep = tools.createGrepTool();",
        "const context = { environment, signal: new AbortController().signal, sessionId: 's', agentName: 'a', fileState: { get() { return undefined; }, set() {} }, depth: 0, isPathDenied: async () => false };",
        "grep.execute(grep.input.parse({ pattern: 'needle' }), context).then((result) => { process.stdout.write(result.promptText); }, (error) => { process.stderr.write(String(error)); process.exit(1); });",
      ].join("\n"),
    );
    const output = execFileSync(process.execPath, [runner, bundle, workspace], { encoding: "utf8", windowsHide: true });
    expect(output).toContain("a.txt:1: needle in haystack");
    expect(output).toContain("sub/b.txt:2: needle again");
  }, 60_000);
});
