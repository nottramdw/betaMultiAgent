import type { ToolCallPart } from "../messages/messages.js";

export const LOOP_NUDGE_AT = 3;
export const LOOP_LIMIT = 12;

export type LoopSignal =
  | { readonly kind: "none" }
  | { readonly kind: "nudge"; readonly tool: string; readonly count: number }
  | { readonly kind: "loop"; readonly tool: string; readonly count: number };

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonical(record[key])]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  const text: string | undefined = JSON.stringify(canonical(value));
  return typeof text === "string" ? text : "null";
}

export class LoopDetector {
  #last: string | undefined;
  #count = 0;

  observe(calls: readonly ToolCallPart[]): LoopSignal {
    let signal: LoopSignal = { kind: "none" };
    for (const call of calls) {
      const signature = `${call.name}\u0000${canonicalJson(call.input)}`;
      this.#count = signature === this.#last ? this.#count + 1 : 1;
      this.#last = signature;
      if (this.#count >= LOOP_LIMIT) {
        return { kind: "loop", tool: call.name, count: this.#count };
      }
      if (this.#count === LOOP_NUDGE_AT) {
        signal = { kind: "nudge", tool: call.name, count: this.#count };
      }
    }
    return signal;
  }

  reset(): void {
    this.#last = undefined;
    this.#count = 0;
  }
}
