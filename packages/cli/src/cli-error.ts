export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_BUDGET = 3;
export const EXIT_STOPPED = 4;
export const EXIT_INTERRUPTED = 130;

export class CliError extends Error {
  readonly exitCode: number;

  constructor(exitCode: number, message: string) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

export function usageError(message: string): CliError {
  return new CliError(EXIT_USAGE, message);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
