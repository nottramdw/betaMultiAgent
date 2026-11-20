export const CAPTURE_LIMIT_BYTES = 1024 * 1024;
const MARKER_RESERVE_BYTES = 128;

export class BoundedCapture {
  readonly #headLimit: number;
  readonly #tailLimit: number;
  readonly #head: Buffer[] = [];
  #tail: Buffer[] = [];
  #headSize = 0;
  #tailSize = 0;
  #total = 0;

  constructor(limitBytes: number = CAPTURE_LIMIT_BYTES) {
    const half = Math.max(1, Math.floor((limitBytes - MARKER_RESERVE_BYTES) / 2));
    this.#headLimit = half;
    this.#tailLimit = half;
  }

  get truncated(): boolean {
    return this.#total > this.#headSize + this.#tailSize;
  }

  push(chunk: Buffer): void {
    this.#total += chunk.length;
    let rest = chunk;
    if (this.#headSize < this.#headLimit) {
      const take = Math.min(rest.length, this.#headLimit - this.#headSize);
      this.#head.push(rest.subarray(0, take));
      this.#headSize += take;
      rest = rest.subarray(take);
    }
    if (rest.length === 0) {
      return;
    }
    this.#tail.push(rest);
    this.#tailSize += rest.length;
    while (this.#tailSize > this.#tailLimit) {
      const first = this.#tail[0];
      if (first === undefined) {
        break;
      }
      const excess = this.#tailSize - this.#tailLimit;
      if (first.length <= excess) {
        this.#tail.shift();
        this.#tailSize -= first.length;
      } else {
        this.#tail[0] = first.subarray(excess);
        this.#tailSize -= excess;
      }
    }
  }

  text(): string {
    if (!this.truncated) {
      return Buffer.concat([...this.#head, ...this.#tail]).toString("utf8");
    }
    const omitted = this.#total - this.#headSize - this.#tailSize;
    const head = Buffer.concat(this.#head).toString("utf8");
    const tail = Buffer.concat(this.#tail).toString("utf8");
    return `${head}\n[... ${String(omitted)} bytes omitted ...]\n${tail}`;
  }
}
