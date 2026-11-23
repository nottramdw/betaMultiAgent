import type { Provider, ProviderEvent, ProviderRequest } from "@betamultiagent/core";
import type { ScriptedProvider } from "@betamultiagent/core/testing";

export interface Route {
  readonly name: string;
  readonly match: (request: ProviderRequest) => boolean;
  readonly script: ScriptedProvider;
  readonly singleRequest?: boolean;
}

export function hasTool(request: ProviderRequest, name: string): boolean {
  return request.tools.some((tool) => tool.name === name);
}

export function mentions(request: ProviderRequest, text: string): boolean {
  return JSON.stringify(request.history).includes(text);
}

class Gate {
  readonly #waiting: ReadonlySet<string>;
  readonly #arrived = new Set<string>();
  readonly #opened: Promise<void>;
  #open: () => void = () => undefined;

  constructor(names: readonly string[], timeoutMs: number) {
    this.#waiting = new Set(names);
    this.#opened = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`routes ${[...this.#waiting].filter((name) => !this.#arrived.has(name)).join(", ")} never started while others waited`));
      }, timeoutMs);
      this.#open = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  async arrive(name: string): Promise<void> {
    if (!this.#waiting.has(name)) {
      return;
    }
    this.#arrived.add(name);
    if ([...this.#waiting].every((entry) => this.#arrived.has(entry))) {
      this.#open();
    }
    await this.#opened;
  }
}

export class RoutedProvider implements Provider {
  readonly id: string;
  readonly #routes: readonly Route[];
  readonly #sessions = new Map<string, Route>();
  readonly #claimed = new Set<string>();
  readonly #gate: Gate | undefined;

  constructor(id: string, routes: readonly Route[], options: { readonly overlap?: readonly string[]; readonly timeoutMs?: number } = {}) {
    this.id = id;
    this.#routes = routes;
    this.#gate = options.overlap === undefined ? undefined : new Gate(options.overlap, options.timeoutMs ?? 20_000);
  }

  claimed(name: string): boolean {
    return this.#claimed.has(name);
  }

  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    let route = this.#sessions.get(request.cacheKey);
    if (route === undefined) {
      route = this.#routes.find((candidate) => !this.#claimed.has(candidate.name) && candidate.match(request));
      if (route === undefined) {
        throw new Error(`no route for a new session with tools ${request.tools.map((tool) => tool.name).join(", ")}`);
      }
      this.#claimed.add(route.name);
      if (route.singleRequest !== true) {
        this.#sessions.set(request.cacheKey, route);
      }
    }
    await this.#gate?.arrive(route.name);
    yield* route.script.stream(request, signal);
  }

  assertDone(): void {
    for (const route of this.#routes) {
      if (!this.#claimed.has(route.name)) {
        throw new Error(`route ${route.name} was never used`);
      }
      route.script.assertDone();
    }
  }
}
