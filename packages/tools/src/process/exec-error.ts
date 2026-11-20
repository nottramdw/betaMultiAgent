export type ExecErrorCode =
  | "command-too-long"
  | "command-not-found"
  | "command-rejected"
  | "invalid-argv"
  | "invalid-cwd"
  | "spawn-failed";

export class ExecError extends Error {
  readonly code: ExecErrorCode;

  constructor(code: ExecErrorCode, message: string) {
    super(message);
    this.name = "ExecError";
    this.code = code;
  }
}
