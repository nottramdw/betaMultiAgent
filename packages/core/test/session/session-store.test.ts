import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createRedactor,
  EVENTS_FILE,
  isStale,
  readSessionEvents,
  SessionCorruptError,
  SessionLockedError,
  SessionStore,
  type EventBody,
} from "../../src/index.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir: string;
const redactor = createRedactor({ secrets: ["sk-test-secret-value"] });

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "bma-session-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const errorEvent = (index: number): EventBody => ({ type: "error", code: "e", message: String(index) });

function line(seq: number, message: string): string {
  return JSON.stringify({ v: 1, seq, ts: "2026-11-20T00:00:00.000Z", type: "error", code: "e", message });
}

describe("SessionStore", () => {
  it("keeps sequence order for concurrent appends", async () => {
    const store = await SessionStore.open({ dir, redactor });
    await Promise.all(Array.from({ length: 1000 }, (_, index) => store.append(errorEvent(index))));
    await store.close();
    const records = await readSessionEvents(dir);
    expect(records.map((record) => record.seq)).toEqual(Array.from({ length: 1000 }, (_, index) => index + 1));
    expect(records.map((record) => (record.type === "error" ? record.message : ""))).toEqual(
      Array.from({ length: 1000 }, (_, index) => String(index)),
    );
  });

  it("truncates an incomplete trailing line and continues the sequence", async () => {
    await writeFile(path.join(dir, EVENTS_FILE), `${line(1, "a")}\n${line(2, "b").slice(0, 20)}`);
    const store = await SessionStore.open({ dir, redactor });
    expect(store.lastSeq).toBe(1);
    const appended = await store.append(errorEvent(2));
    expect(appended.seq).toBe(2);
    await store.close();
    const text = await readFile(path.join(dir, EVENTS_FILE), "utf8");
    expect(text.split("\n").filter(Boolean)).toHaveLength(2);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("drops an unparsable final line", async () => {
    await writeFile(path.join(dir, EVENTS_FILE), `${line(1, "a")}\n{not json}\n`);
    const store = await SessionStore.open({ dir, redactor });
    expect(store.records()).toHaveLength(1);
    await store.close();
  });

  it("rejects corruption in the middle of the log and releases the lock", async () => {
    await writeFile(path.join(dir, EVENTS_FILE), `${line(1, "a")}\ngarbage\n${line(3, "c")}\n`);
    await expect(SessionStore.open({ dir, redactor })).rejects.toBeInstanceOf(SessionCorruptError);
    await expect(SessionStore.open({ dir, redactor })).rejects.toBeInstanceOf(SessionCorruptError);
  });

  it("refuses a second lock holder", async () => {
    const store = await SessionStore.open({ dir, redactor });
    await expect(SessionStore.open({ dir, redactor })).rejects.toBeInstanceOf(SessionLockedError);
    await store.close();
    const reopened = await SessionStore.open({ dir, redactor });
    await reopened.close();
  });

  it("redacts secrets before writing", async () => {
    const store = await SessionStore.open({ dir, redactor });
    await store.append({
      type: "message",
      message: { role: "user", parts: [{ type: "text", text: "key sk-test-secret-value and sk-ant-abcdefghijkl" }] },
    });
    await store.close();
    const text = await readFile(path.join(dir, EVENTS_FILE), "utf8");
    expect(text).not.toContain("sk-test-secret-value");
    expect(text).not.toContain("sk-ant-abcdefghijkl");
    expect(text).toContain("[REDACTED]");
  });

  it("replays messages in order", async () => {
    const store = await SessionStore.open({ dir, redactor });
    await store.append({ type: "message", message: { role: "user", parts: [{ type: "text", text: "one" }] } });
    await store.append(errorEvent(0));
    await store.append({ type: "message", message: { role: "user", parts: [{ type: "text", text: "two" }] } });
    expect(store.messages()).toHaveLength(2);
    await store.close();
  });
});

describe("isStale", () => {
  const lock = { pid: 4242, hostname: "host-a", startedAt: "2026-11-20T00:00:00.000Z", token: "t" };

  it("is stale only for a dead pid on the same host", () => {
    expect(isStale(lock, { hostname: "host-a", isAlive: () => false })).toBe(true);
    expect(isStale(lock, { hostname: "host-a", isAlive: () => true })).toBe(false);
    expect(isStale(lock, { hostname: "host-b", isAlive: () => false })).toBe(false);
  });
});
