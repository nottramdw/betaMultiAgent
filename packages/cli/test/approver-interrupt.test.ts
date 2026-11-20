import { createRedactor, type PermissionRequest, type PermissionVerdict } from "@betamultiagent/core";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ApprovalQueue, LineReader } from "../src/approver/approval-queue.js";
import { createTtyApprover, createTtyCommandApprover, type PromptChannel } from "../src/approver/tty-approver.js";
import { EXIT_INTERRUPTED } from "../src/cli-error.js";
import { TerminalWriter } from "../src/output/human.js";
import { installInterruptHandler } from "../src/process/interrupt.js";
import { CaptureStream } from "./cli-harness.js";

function channel(lines: readonly string[], end = true): { channel: PromptChannel; output: CaptureStream; input: PassThrough } {
  const input = new PassThrough();
  for (const line of lines) {
    input.write(`${line}\n`);
  }
  if (end) {
    input.end();
  }
  const output = new CaptureStream(true);
  return {
    channel: { queue: new ApprovalQueue(), reader: new LineReader(input), writer: new TerminalWriter(output, createRedactor()) },
    output,
    input,
  };
}

const ASK: PermissionVerdict = { decision: "ask", source: "fallback", reason: "write requires approval", sensitive: false };
const SENSITIVE: PermissionVerdict = { ...ASK, sensitive: true };
const WRITE: PermissionRequest = { kind: "write", paths: ["src/a.ts"] };

describe("createTtyApprover", () => {
  it("maps y, a and n to approval answers", async () => {
    const { channel: prompt, output } = channel(["y", "a", "n"]);
    const approve = createTtyApprover(prompt, "executor");
    expect(await approve(WRITE, ASK)).toBe("allow-once");
    expect(await approve(WRITE, ASK)).toBe("allow-session");
    expect(await approve(WRITE, ASK)).toBe("deny");
    expect(output.text).toContain("[executor] requests permission");
    prompt.reader.close();
  });

  it("denies at end of input", async () => {
    const { channel: prompt } = channel([]);
    expect(await createTtyApprover(prompt, "executor")(WRITE, ASK)).toBe("deny");
  });

  it("does not offer session approval for sensitive writes", async () => {
    const { channel: prompt, output } = channel(["a", "y"]);
    expect(await createTtyApprover(prompt, "executor")({ kind: "write", paths: ["package.json"] }, SENSITIVE)).toBe("allow-once");
    expect(output.text).toContain("WARNING");
    expect(output.text).not.toContain("[a] allow");
  });

  it("serializes concurrent prompts from parallel agents", async () => {
    const { channel: prompt, output } = channel(["y", "n"]);
    const first = createTtyApprover(prompt, "lead");
    const second = createTtyApprover(prompt, "researcher");
    const answers = await Promise.all([first(WRITE, ASK), second(WRITE, ASK)]);
    expect(answers).toEqual(["allow-once", "deny"]);
    expect(output.text.indexOf("[lead]")).toBeLessThan(output.text.indexOf("[researcher]"));
  });
});

describe("createTtyCommandApprover", () => {
  it("lists the commands and requires an explicit yes", async () => {
    const { channel: prompt, output } = channel(["", "yes"]);
    const approve = createTtyCommandApprover(prompt);
    expect(await approve([{ argv: ["pnpm", "test"] }], "verify")).toBe(false);
    expect(await approve([{ argv: ["pnpm", "test"] }], "verify")).toBe(true);
    expect(output.text).toContain('["pnpm","test"]');
  });
});

describe("installInterruptHandler", () => {
  it("aborts on the first interrupt and kills process trees on the second", () => {
    const listeners: (() => void)[] = [];
    const controller = new AbortController();
    const messages: string[] = [];
    let killed = 0;
    let exitCode: number | undefined;
    const uninstall = installInterruptHandler({
      signals: {
        on: (_signal, listener) => listeners.push(listener),
        off: (_signal, listener) => listeners.splice(listeners.indexOf(listener), 1),
      },
      controller,
      notify: (message) => messages.push(message),
      exit: (code) => {
        exitCode = code;
        throw new Error("exit");
      },
      killProcessTrees: () => {
        killed += 1;
        return [];
      },
    });
    listeners[0]?.();
    expect(controller.signal.aborted).toBe(true);
    expect(messages[0]).toContain("Ctrl+C again");
    expect(killed).toBe(0);
    expect(() => listeners[0]?.()).toThrow("exit");
    expect(killed).toBe(1);
    expect(exitCode).toBe(EXIT_INTERRUPTED);
    uninstall();
    expect(listeners).toHaveLength(0);
  });
});
