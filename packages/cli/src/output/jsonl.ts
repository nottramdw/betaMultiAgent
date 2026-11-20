import { PROTOCOL_VERSION, type EventListener, type EventRecord, type Redactor } from "@betamultiagent/core";
import type { OutputStream } from "../cli-io.js";

export class JsonlWriter implements EventListener {
  readonly #stream: OutputStream;
  readonly #redactor: Redactor;

  constructor(stream: OutputStream, redactor: Redactor) {
    this.#stream = stream;
    this.#redactor = redactor;
  }

  onRecord(record: EventRecord): void {
    this.write(record);
  }

  write(value: unknown): void {
    this.#stream.write(`${JSON.stringify(this.#redactor.redactValue(value))}\n`);
  }

  writeResult(type: string, body: Record<string, unknown>): void {
    this.write({ v: PROTOCOL_VERSION, type, ...body });
  }
}
