import { ScriptedProvider } from "@betamultiagent/core/testing";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from "../src/cli-error.js";
import { makeSandbox, registerCleanup, runBma, writeTree, type Sandbox } from "./cli-harness.js";

registerCleanup();

const SECRET = "sk-ant-test-0123456789abcdefghij";

function claude(...texts: string[]): ScriptedProvider {
  return new ScriptedProvider(
    texts.map((text) => ({ respond: { text } })),
    { id: "claude" },
  );
}

function sessionIds(sandbox: Sandbox): string[] {
  const projects = path.join(sandbox.bmaHome, "state", "projects");
  return readdirSync(projects).flatMap((key) => readdirSync(path.join(projects, key, "sessions")));
}

describe("bma entry point", () => {
  it("prints help and version", async () => {
    const sandbox = makeSandbox();
    const help = await runBma(sandbox, ["--help"]);
    expect(help.code).toBe(EXIT_OK);
    expect(help.stdout.text).toContain("bma team <task>");
    const bare = await runBma(sandbox, []);
    expect(bare.code).toBe(EXIT_USAGE);
    const version = await runBma(sandbox, ["--version"]);
    expect(version.stdout.text.trim()).toBe("0.0.0-dev");
  });

  it("rejects unknown commands and options with exit code 2", async () => {
    const sandbox = makeSandbox();
    expect((await runBma(sandbox, ["deploy"])).code).toBe(EXIT_USAGE);
    const bad = await runBma(sandbox, ["models", "--nope"]);
    expect(bad.code).toBe(EXIT_USAGE);
    expect(bad.stderr.text).toContain("bma:");
  });
});

describe("bma models", () => {
  it("lists both catalogs without any API key", async () => {
    const sandbox = makeSandbox();
    const result = await runBma(sandbox, ["models"]);
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout.text).toContain("claude:claude-opus-5-5");
    expect(result.stdout.text).toContain("grok:grok-4.7");
    expect(result.stdout.text).toMatch(/prices as of \d{4}-\d{2}-\d{2}/u);
  });

  it("filters by provider and emits JSON", async () => {
    const sandbox = makeSandbox();
    const result = await runBma(sandbox, ["models", "--provider", "grok", "--json"]);
    const [line] = result.stdout.jsonLines();
    expect(line).toMatchObject({ v: 1, type: "models" });
    const refs = (line?.["models"] as { ref: string }[]).map((entry) => entry.ref);
    expect(refs.every((ref) => ref.startsWith("grok:"))).toBe(true);
    expect((await runBma(sandbox, ["models", "--provider", "openai"])).code).toBe(EXIT_USAGE);
  });
});

describe("bma run", () => {
  it("answers through the provider, warns about trust and records a session", async () => {
    const sandbox = makeSandbox();
    const provider = claude("Hello from the model.");
    const result = await runBma(sandbox, ["run", "say hello"], { providers: { claude: provider } });
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout.text).toContain("Hello from the model.");
    expect(result.stderr.text).toContain("workspace is not trusted");
    expect(result.stderr.text).toMatch(/session [0-9A-HJKMNP-TV-Z]{26}, cost \$0\.0000/u);
    provider.assertDone();
    expect(provider.requests[0]?.model).toBe("claude-sonnet-5-5");
    expect(sessionIds(sandbox)).toHaveLength(1);
  });

  it("reads the prompt from standard input and gives read-only tools to non-executor roles", async () => {
    const sandbox = makeSandbox();
    const provider = claude("Answer.");
    const result = await runBma(sandbox, ["run", "--role", "researcher"], { stdin: "what is here?", providers: { claude: provider } });
    expect(result.code).toBe(EXIT_OK);
    const tools = provider.requests[0]?.tools.map((tool) => tool.name) ?? [];
    expect(tools).toContain("read_file");
    expect(tools).not.toContain("write_file");
    expect(tools).not.toContain("run_command");
    expect(provider.requests[0]?.model).toBe("claude-haiku-5-5");
  });

  it("emits redacted JSON lines in JSON mode", async () => {
    const sandbox = makeSandbox();
    const provider = claude(`the key is ${SECRET}`);
    const result = await runBma(sandbox, ["run", "--json", "-p", "leak it"], {
      env: { ANTHROPIC_API_KEY: SECRET },
      providers: { claude: provider },
    });
    expect(result.code).toBe(EXIT_OK);
    const lines = result.stdout.jsonLines();
    expect(lines.some((line) => line["type"] === "session-start")).toBe(true);
    expect(lines.some((line) => line["type"] === "outcome")).toBe(true);
    expect(result.stdout.text).not.toContain(SECRET);
    expect(result.stderr.text).not.toContain(SECRET);
  });

  it("fails with exit code 2 when no provider key is available", async () => {
    const sandbox = makeSandbox();
    const result = await runBma(sandbox, ["run", "hi"]);
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr.text).toMatch(/API key/u);
  });

  it("appends configured role instructions to the built-in ones", async () => {
    const sandbox = makeSandbox();
    writeTree(sandbox.bmaHome, { "config/config.json": JSON.stringify({ roles: { researcher: { model: "claude:claude-haiku-5-5", instructions: "Cite line numbers." } } }) });
    const provider = claude("Answer.");
    const result = await runBma(sandbox, ["run", "--role", "researcher", "where?"], { providers: { claude: provider } });
    expect(result.code).toBe(EXIT_OK);
    const system = provider.requests[0]?.system ?? "";
    expect(system).toContain("You cannot change files or run commands.");
    expect(system).toContain("Cite line numbers.");
  });

  it("keeps the default model when a role setting names only an effort", async () => {
    const sandbox = makeSandbox();
    writeTree(sandbox.bmaHome, { "config/config.json": JSON.stringify({ roles: { researcher: { effort: "low", maxCostUsd: 0.2 } } }) });
    const provider = claude("Answer.");
    const result = await runBma(sandbox, ["run", "--role", "researcher", "where?"], { providers: { claude: provider } });
    expect(result.code).toBe(EXIT_OK);
    expect(provider.requests[0]).toMatchObject({ model: "claude-haiku-5-5", effort: "low" });
  });

  it("rejects an unknown model and a duplicated prompt", async () => {
    const sandbox = makeSandbox();
    const providers = { claude: claude() };
    expect((await runBma(sandbox, ["run", "-m", "claude:claude-nope", "hi"], { providers })).code).toBe(EXIT_USAGE);
    expect((await runBma(sandbox, ["run", "-p", "a", "b"], { providers })).code).toBe(EXIT_USAGE);
  });

  it("refuses a project configuration that contains secrets", async () => {
    const sandbox = makeSandbox();
    writeTree(sandbox.workspace, { "bma.config.json": JSON.stringify({ token: "abc" }) });
    const result = await runBma(sandbox, ["run", "hi"], { providers: { claude: claude() } });
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr.text).toMatch(/must not contain credentials/u);
  });
});

describe("bma sessions", () => {
  it("lists, shows, removes and prunes sessions", async () => {
    const sandbox = makeSandbox();
    const providers = { claude: claude("one", "two") };
    await runBma(sandbox, ["run", "first"], { providers, now: new Date("2026-01-01T00:00:00Z") });
    await runBma(sandbox, ["run", "second"], { providers, now: new Date("2026-11-19T00:00:00Z") });
    const [oldId, newId] = sessionIds(sandbox).sort();
    if (oldId === undefined || newId === undefined) {
      throw new Error("expected two sessions");
    }
    const list = await runBma(sandbox, ["sessions", "list"]);
    expect(list.stdout.text).toContain(oldId);
    expect(list.stdout.text).toContain("claude:claude-sonnet-5-5");
    expect(list.stdout.text).toContain("completed");
    const listJson = await runBma(sandbox, ["sessions", "--json"]);
    expect(listJson.code).toBe(EXIT_OK);
    expect(listJson.stdout.jsonLines().length).toBeGreaterThan(0);
    const show = await runBma(sandbox, ["sessions", "show", newId, "--json"]);
    expect(show.stdout.jsonLines().some((line) => line["type"] === "message")).toBe(true);
    expect((await runBma(sandbox, ["sessions", "show", "../escape"])).code).toBe(EXIT_USAGE);
    const prune = await runBma(sandbox, ["sessions", "prune", "--older-than", "30"], { now: new Date("2026-11-20T00:00:00Z") });
    expect(prune.stderr.text).toContain("removed 1 session(s)");
    expect(sessionIds(sandbox)).toEqual([newId]);
    expect((await runBma(sandbox, ["sessions", "rm", newId])).code).toBe(EXIT_OK);
    expect(sessionIds(sandbox)).toEqual([]);
    expect((await runBma(sandbox, ["sessions", "rm", newId])).code).toBe(EXIT_USAGE);
  });
});

describe("bma doctor", () => {
  it("reports key presence without printing keys", async () => {
    const sandbox = makeSandbox();
    const result = await runBma(sandbox, ["doctor", "--json"], { env: { ANTHROPIC_API_KEY: SECRET } });
    expect(result.code).toBe(EXIT_OK);
    const [report] = result.stdout.jsonLines();
    const checks = report?.["checks"] as { name: string; level: string; detail: string }[];
    expect(checks.find((check) => check.name === "keys")?.detail).toContain("ANTHROPIC_API_KEY true");
    expect(checks.find((check) => check.name === "trust")?.detail).toContain("not trusted");
    expect(result.stdout.text).not.toContain(SECRET);
  });

  it("fails when the configuration is invalid", async () => {
    const sandbox = makeSandbox();
    writeTree(sandbox.workspace, { "bma.config.json": "{ broken" });
    const result = await runBma(sandbox, ["doctor"]);
    expect(result.code).toBe(EXIT_FAILED);
    expect(result.stdout.text).toContain("[error] workspace");
  });
});

describe("bma trust", () => {
  it("refuses to trust without a terminal", async () => {
    const sandbox = makeSandbox();
    const result = await runBma(sandbox, ["trust"], { stdinIsTTY: false });
    expect(result.code).toBe(EXIT_USAGE);
    expect(existsSync(path.join(sandbox.bmaHome, "state", "trust.json"))).toBe(false);
  });

  it("shows what trust activates, grants it after confirmation and revokes it", async () => {
    const sandbox = makeSandbox();
    writeTree(sandbox.workspace, {
      "bma.config.json": JSON.stringify({ permissions: { rules: [{ kind: "write", match: "src/**", decision: "allow" }] }, team: { setup: [["pnpm", "install"]] } }),
      "AGENTS.md": "Use pnpm.\n",
    });
    const granted = await runBma(sandbox, ["trust"], { stdin: "y\n", stdinIsTTY: true, stderrIsTTY: true });
    expect(granted.code).toBe(EXIT_OK);
    expect(granted.stderr.text).toContain("src/**");
    expect(granted.stderr.text).toContain('[["pnpm","install"]]');
    expect(granted.stderr.text).toContain("AGENTS.md");
    expect(granted.stderr.text).toContain("bma: trusted");
    const doctor = await runBma(sandbox, ["doctor", "--json"]);
    const checks = doctor.stdout.jsonLines()[0]?.["checks"] as { name: string; detail: string }[];
    expect(checks.find((check) => check.name === "trust")?.detail).toBe("trusted");
    writeTree(sandbox.workspace, { "bma.config.json": JSON.stringify({}) });
    const changed = await runBma(sandbox, ["doctor", "--json"]);
    const after = changed.stdout.jsonLines()[0]?.["checks"] as { name: string; detail: string }[];
    expect(after.find((check) => check.name === "trust")?.detail).toContain("not trusted");
    const revoked = await runBma(sandbox, ["trust", "--revoke"]);
    expect(revoked.stderr.text).toContain("trust revoked");
  });

  it("does not trust when the answer is not yes", async () => {
    const sandbox = makeSandbox();
    const result = await runBma(sandbox, ["trust"], { stdin: "n\n", stdinIsTTY: true, stderrIsTTY: true });
    expect(result.code).toBe(EXIT_OK);
    expect(result.stderr.text).toContain("not trusted");
  });
});
