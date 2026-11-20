import { createInterface, type Interface } from "node:readline";

export class ApprovalQueue {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(task, task);
    this.#tail = next.catch(() => undefined);
    return next;
  }
}

export class LineReader {
  readonly #input: NodeJS.ReadableStream;
  #readline: Interface | undefined;
  #lines: AsyncIterator<string> | undefined;

  constructor(input: NodeJS.ReadableStream) {
    this.#input = input;
  }

  async next(): Promise<string | undefined> {
    if (this.#lines === undefined) {
      this.#readline = createInterface({ input: this.#input, crlfDelay: Infinity, terminal: false });
      this.#lines = this.#readline[Symbol.asyncIterator]();
    }
    const result = await this.#lines.next();
    return result.done === true ? undefined : result.value;
  }

  close(): void {
    this.#readline?.close();
  }
}
