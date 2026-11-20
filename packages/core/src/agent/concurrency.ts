export type Release = () => void;

interface Waiter {
  readonly exclusive: boolean;
  readonly resolve: (release: Release) => void;
}

export class ExclusiveGate {
  #shared = 0;
  #exclusive = false;
  readonly #queue: Waiter[] = [];

  acquire(exclusive: boolean): Promise<Release> {
    return new Promise((resolve) => {
      this.#queue.push({ exclusive, resolve });
      this.#drain();
    });
  }

  #drain(): void {
    for (;;) {
      const next = this.#queue[0];
      if (next === undefined || this.#exclusive) {
        return;
      }
      if (next.exclusive) {
        if (this.#shared > 0) {
          return;
        }
        this.#queue.shift();
        this.#exclusive = true;
        next.resolve(this.#once(() => {
          this.#exclusive = false;
        }));
        return;
      }
      this.#queue.shift();
      this.#shared += 1;
      next.resolve(this.#once(() => {
        this.#shared -= 1;
      }));
    }
  }

  #once(action: () => void): Release {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      action();
      this.#drain();
    };
  }
}

export class Semaphore {
  readonly #limit: number;
  #active = 0;
  readonly #queue: ((release: Release) => void)[] = [];

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`semaphore limit must be a positive integer, got ${String(limit)}`);
    }
    this.#limit = limit;
  }

  acquire(): Promise<Release> {
    return new Promise((resolve) => {
      this.#queue.push(resolve);
      this.#drain();
    });
  }

  #drain(): void {
    while (this.#active < this.#limit) {
      const next = this.#queue.shift();
      if (next === undefined) {
        return;
      }
      this.#active += 1;
      let released = false;
      next(() => {
        if (released) {
          return;
        }
        released = true;
        this.#active -= 1;
        this.#drain();
      });
    }
  }
}
