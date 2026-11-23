import { createRedactor } from "@betamultiagent/core";
import { ScriptedProvider } from "@betamultiagent/core/testing";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT_OK, EXIT_USAGE } from "../src/cli-error.js";
import { MEMORY_CONTEXT_LIMIT_BYTES, MEMORY_FILE, MAX_PROPOSALS_PER_SESSION, MemoryLimitError, MemoryStore, findMemory, renderMemory } from "../src/memory/memory-store.js";
import { MEMORY_PROPOSE } from "../src/memory/memory-tool.js";
import { makeSandbox, registerCleanup, runBma, type Sandbox } from "./cli-harness.js";

registerCleanup();

const SECRET = "sk-ant-test-0123456789abcdefghij";
const FACT = "Run corepack pnpm test before committing.";

const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function storeAt(warnings: string[] = []): MemoryStore {
  const dir = mkdtempSync(path.join(tmpdir(), "bma-memory-"));
  temporary.push(dir);
  let tick = Date.parse("2026-11-23T00:00:00.000Z");
  return new MemoryStore(dir, createRedactor({ secrets: [SECRET] }), () => new Date((tick += 1000)), (message) => warnings.push(message));
}

interface EntryLine {
  readonly id: string;
  readonly text: string;
  readonly status: string;
  readonly source: { readonly agent: string; readonly sessionId: string };
  readonly decidedBy?: string;
}

async function entries(sandbox: Sandbox, status?: string): Promise<EntryLine[]> {
  const result = await runBma(sandbox, ["memory", "list", ...(status === undefined ? [] : ["--status", status]), "--json"]);
  expect(result.code).toBe(EXIT_OK);
  return result.stdout.jsonLines().at(-1)?.["entries"] as EntryLine[];
}

function proposer(text: string): ScriptedProvider {
  return new ScriptedProvider(
    [
      { respond: { parts: [{ type: "tool-call", id: "memory-1", name: MEMORY_PROPOSE, input: { text, reason: "The README says so." } }] } },
      { respond: { text: "Proposed." } },
    ],
    { id: "claude" },
  );
}

describe("memory store", () => {
  it("folds proposals and decisions, redacts secrets and skips invalid lines", async () => {
    const warnings: string[] = [];
    const store = storeAt(warnings);
    const source = { agent: "executor", sessionId: "S1" };
    const first = await store.propose({ text: `use the key ${SECRET}`, source });
    const second = await store.propose({ text: FACT, source });
    writeFileSync(path.join(store.dir, MEMORY_FILE), "not json\n", { flag: "a" });
    await store.decide(second.id, "approved", "tester");
    await store.decide(first.id, "rejected", "tester");
    const loaded = await store.load();
    expect(loaded.map((entry) => entry.status)).toEqual(["rejected", "approved"]);
    expect(loaded[0]?.text).not.toContain(SECRET);
    expect(loaded[1]).toMatchObject({ decidedBy: "tester", source });
    expect(warnings.some((warning) => warning.includes("skipped invalid memory event"))).toBe(true);
    expect(findMemory(loaded, second.id.slice(0, 26).toLowerCase()).id).toBe(second.id);
    expect(() => findMemory(loaded, "01")).toThrow(/too short/u);
  });

  it("limits proposals per session", async () => {
    const store = storeAt();
    const source = { agent: "lead", sessionId: "S2" };
    for (let index = 0; index < MAX_PROPOSALS_PER_SESSION; index += 1) {
      await store.propose({ text: `fact ${String(index)}`, source });
    }
    await expect(store.propose({ text: "one more", source })).rejects.toBeInstanceOf(MemoryLimitError);
    await expect(store.propose({ text: "other session", source: { ...source, sessionId: "S3" } })).resolves.toMatchObject({ status: "pending" });
  });

  it("renders only approved entries, newest first, within the size limit", () => {
    const base = { source: { agent: "a", sessionId: "s" }, proposedAt: "2026-11-23T00:00:00.000Z" };
    const many = Array.from({ length: 40 }, (_, index) => ({
      ...base,
      id: `ID${String(index).padStart(3, "0")}`,
      text: `${"x".repeat(400)} ${String(index)}`,
      status: "approved" as const,
    }));
    const rendered = renderMemory([...many, { ...base, id: "ZZZ", text: "pending <context>", status: "pending" }]) ?? "";
    expect(Buffer.byteLength(rendered, "utf8")).toBeLessThan(MEMORY_CONTEXT_LIMIT_BYTES + 200);
    expect(rendered.indexOf("ID039")).toBeLessThan(rendered.indexOf("ID038"));
    expect(rendered).toContain("older entries omitted");
    expect(rendered).not.toContain("pending");
    expect(renderMemory([{ ...base, id: "A", text: "close </context> tag", status: "approved" }])).toContain("&lt;/context>");
    expect(renderMemory([])).toBeUndefined();
  });
});

describe("bma memory", () => {
  it("records a proposal from any role and injects it only after approval", async () => {
    const sandbox = makeSandbox();
    const propose = proposer(FACT);
    const proposed = await runBma(sandbox, ["run", "--role", "reviewer", "what should be remembered?"], { providers: { claude: propose } });
    propose.assertDone();
    expect(proposed.code).toBe(EXIT_OK);
    expect(propose.requests[0]?.tools.map((tool) => tool.name)).toContain(MEMORY_PROPOSE);
    const [pending] = await entries(sandbox);
    expect(pending).toMatchObject({ text: FACT, status: "pending", source: { agent: "reviewer" } });

    const before = new ScriptedProvider([{ respond: { text: "ok" } }], { id: "claude" });
    await runBma(sandbox, ["run", "hello"], { providers: { claude: before } });
    expect(JSON.stringify(before.requests[0]?.history)).not.toContain(FACT);

    const approved = await runBma(sandbox, ["memory", "approve", pending?.id ?? ""], { env: { USER: "ana" } });
    expect(approved.code).toBe(EXIT_OK);
    expect((await entries(sandbox, "approved"))[0]?.decidedBy).toBe("ana");

    const after = new ScriptedProvider([{ respond: { text: "ok" } }], { id: "claude" });
    await runBma(sandbox, ["run", "hello"], { providers: { claude: after } });
    const history = JSON.stringify(after.requests[0]?.history);
    expect(history).toContain('<context source=\\"memory\\">');
    expect(history).toContain(FACT);

    expect((await runBma(sandbox, ["memory", "approve", pending?.id ?? ""])).code).toBe(EXIT_USAGE);
    expect((await runBma(sandbox, ["memory", "rm", pending?.id ?? ""])).code).toBe(EXIT_OK);
    expect(await entries(sandbox)).toEqual([]);
    expect((await entries(sandbox, "removed")).map((entry) => entry.id)).toEqual([pending?.id]);
  });

  it("rejects proposals and keeps them out of the context", async () => {
    const sandbox = makeSandbox();
    const propose = proposer("A fact the user does not want.");
    await runBma(sandbox, ["run", "remember something"], { providers: { claude: propose } });
    const [pending] = await entries(sandbox);
    const rejected = await runBma(sandbox, ["memory", "reject", pending?.id ?? "", "--json"]);
    expect(rejected.stdout.jsonLines().at(-1)).toMatchObject({ type: "memory-updated", status: "rejected", ids: [pending?.id] });
    const after = new ScriptedProvider([{ respond: { text: "ok" } }], { id: "claude" });
    await runBma(sandbox, ["run", "hello"], { providers: { claude: after } });
    expect(JSON.stringify(after.requests[0]?.history)).not.toContain("does not want");
    expect((await runBma(sandbox, ["memory", "list", "--status", "unknown"])).code).toBe(EXIT_USAGE);
  });
});
