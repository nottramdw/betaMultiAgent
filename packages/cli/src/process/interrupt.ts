import { killTrackedProcessTreesSync } from "@betamultiagent/tools";
import type { SignalSource } from "../cli-io.js";
import { EXIT_INTERRUPTED } from "../cli-error.js";

export interface InterruptOptions {
  readonly signals: SignalSource;
  readonly controller: AbortController;
  readonly notify: (message: string) => void;
  readonly exit: (code: number) => never;
  readonly killProcessTrees?: () => readonly number[];
}

export function installInterruptHandler(options: InterruptOptions): () => void {
  let count = 0;
  const kill = options.killProcessTrees ?? killTrackedProcessTreesSync;
  const onInterrupt = (): void => {
    count += 1;
    if (count === 1) {
      options.notify("bma: interrupting; press Ctrl+C again to stop immediately");
      options.controller.abort();
      return;
    }
    kill();
    options.exit(EXIT_INTERRUPTED);
  };
  options.signals.on("SIGINT", onInterrupt);
  return () => {
    options.signals.off("SIGINT", onInterrupt);
  };
}
