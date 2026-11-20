import type { Release } from "./concurrency.js";

export class PathLocks {
  readonly #caseSensitive: boolean;
  readonly #tails = new Map<string, Promise<void>>();

  constructor(caseSensitive: boolean) {
    this.#caseSensitive = caseSensitive;
  }

  key(realPath: string): string {
    return this.#caseSensitive ? realPath : realPath.toLowerCase();
  }

  async acquire(realPaths: readonly string[]): Promise<Release> {
    const keys = [...new Set(realPaths.map((realPath) => this.key(realPath)))].sort();
    const releases: Release[] = [];
    for (const key of keys) {
      releases.push(await this.#lock(key));
    }
    return () => {
      for (const release of releases.reverse()) {
        release();
      }
    };
  }

  #lock(key: string): Promise<Release> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let unlock: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const tail = previous.then(() => current);
    this.#tails.set(key, tail);
    return previous.then(() => {
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        unlock();
        if (this.#tails.get(key) === tail) {
          this.#tails.delete(key);
        }
      };
    });
  }
}
