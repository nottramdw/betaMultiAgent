import type { EventListener, EventRecord, PermissionRequest, Redactor, StreamDelta } from "@betamultiagent/core";
import type { OutputStream } from "../cli-io.js";
import { displayArgv, displayValue, sanitizeTerminal, truncateDisplay } from "./sanitize.js";

export function describeRequest(request: PermissionRequest): string {
  switch (request.kind) {
    case "none":
      return "no permission";
    case "exec":
      return `exec ${displayArgv(request.argv)}`;
    case "read":
    case "write":
      return `${request.kind} ${request.paths.map((item) => displayValue(item)).join(", ")}`;
  }
}

function firstLine(text: string): string {
  const line = text.split("\n").find((entry) => entry.trim().length > 0) ?? "";
  return truncateDisplay(line.trim(), 160);
}

export class TerminalWriter {
  readonly #stream: OutputStream;
  readonly #redactor: Redactor;

  constructor(stream: OutputStream, redactor: Redactor) {
    this.#stream = stream;
    this.#redactor = redactor;
  }

  write(text: string): void {
    this.#stream.write(this.#redactor.redact(sanitizeTerminal(text)));
  }

  line(text: string): void {
    this.write(`${text}\n`);
  }
}

export interface HumanRendererOptions {
  readonly stdout: TerminalWriter;
  readonly stderr: TerminalWriter;
  readonly streamText: boolean;
}

export class HumanRenderer implements EventListener {
  readonly #stdout: TerminalWriter;
  readonly #stderr: TerminalWriter;
  readonly #streamText: boolean;
  #pending = "";
  #wroteText = false;
  #costUsd = 0;

  constructor(options: HumanRendererOptions) {
    this.#stdout = options.stdout;
    this.#stderr = options.stderr;
    this.#streamText = options.streamText;
  }

  get costUsd(): number {
    return this.#costUsd;
  }

  onDelta(delta: StreamDelta): void {
    if (!this.#streamText || delta.type !== "text-delta") {
      return;
    }
    this.#pending += delta.text;
    const end = this.#pending.lastIndexOf("\n");
    if (end >= 0) {
      this.#stdout.write(this.#pending.slice(0, end + 1));
      this.#pending = this.#pending.slice(end + 1);
      this.#wroteText = true;
    }
  }

  flush(): void {
    if (this.#pending.length > 0) {
      this.#stdout.write(`${this.#pending}\n`);
      this.#pending = "";
      this.#wroteText = true;
    }
  }

  get wroteText(): boolean {
    return this.#wroteText;
  }

  onRecord(record: EventRecord): void {
    switch (record.type) {
      case "session-start":
        this.#stderr.line(`bma: ${record.agentName} using ${record.provider}:${record.model}`);
        return;
      case "context-loaded":
        this.#stderr.line(`bma: loaded instructions: ${record.sources.join(", ")}`);
        return;
      case "tool-start":
        this.flush();
        this.#stderr.line(`  -> ${record.name} ${displayValue(record.input, 160)}`);
        return;
      case "tool-end":
        if (record.isError) {
          this.#stderr.line(`  x ${record.name}: ${firstLine(record.promptText)}`);
        }
        return;
      case "permission":
        if (!record.allowed) {
          this.#stderr.line(`  denied ${describeRequest(record.request)}: ${record.reason}`);
        } else if (record.approval !== undefined) {
          this.#stderr.line(`  approved (${record.approval}) ${describeRequest(record.request)}`);
        }
        return;
      case "usage":
        this.#costUsd += record.usage.costUsd ?? 0;
        return;
      case "compaction":
        this.#stderr.line(`bma: compacted ${String(record.replacedMessages)} message(s) (${record.trigger})`);
        return;
      case "error":
        this.#stderr.line(`bma: error ${record.code}: ${record.message}`);
        return;
      case "team-phase":
        this.#stderr.line(`[team] ${record.phase}${record.detail === undefined ? "" : `: ${record.detail}`}`);
        return;
      case "outcome":
        this.flush();
        return;
      case "message":
        return;
    }
  }
}
