import os from "node:os";

export interface OutputStream {
  readonly isTTY: boolean;
  write(text: string): void;
}

export interface SignalSource {
  on(signal: "SIGINT", listener: () => void): unknown;
  off(signal: "SIGINT", listener: () => void): unknown;
}

export interface CliIo {
  readonly stdout: OutputStream;
  readonly stderr: OutputStream;
  readonly stdin: NodeJS.ReadableStream;
  readonly stdinIsTTY: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly platform: NodeJS.Platform;
  readonly homedir: string;
  readonly signals: SignalSource;
  readonly exit: (code: number) => never;
  readonly now: () => Date;
}

function stream(target: NodeJS.WriteStream): OutputStream {
  return {
    isTTY: target.isTTY,
    write: (text) => {
      target.write(text);
    },
  };
}

export function processIo(): CliIo {
  return {
    stdout: stream(process.stdout),
    stderr: stream(process.stderr),
    stdin: process.stdin,
    stdinIsTTY: process.stdin.isTTY,
    env: process.env,
    cwd: process.cwd(),
    platform: process.platform,
    homedir: os.homedir(),
    signals: process,
    exit: (code) => process.exit(code),
    now: () => new Date(),
  };
}
