export type EnvMap = Readonly<Record<string, string | undefined>>;

const ALLOWED_NAMES: readonly string[] = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "SystemDrive",
  "windir",
  "ComSpec",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "USERNAME",
  "USER",
  "LOGNAME",
  "SHELL",
  "APPDATA",
  "LOCALAPPDATA",
  "LANG",
  "LC_*",
  "TERM",
];

const NEVER_PASSED_PREFIXES: readonly string[] = ["ANTHROPIC_", "XAI_"];

const FORCED: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
  PAGER: "cat",
  NO_COLOR: "1",
  BMA_AGENT_CHILD: "1",
};

const DEFAULTS: Readonly<Record<string, string>> = {
  PYTHONUTF8: "1",
  PYTHONIOENCODING: "utf-8",
};

export interface ChildEnvOptions {
  readonly baseEnv: EnvMap;
  readonly platform: NodeJS.Platform;
  readonly passthrough?: readonly string[];
  readonly denylist?: readonly string[];
  readonly extra?: Readonly<Record<string, string>>;
  readonly additionalForced?: Readonly<Record<string, string>>;
}

function matchesPattern(name: string, pattern: string, fold: (value: string) => string): boolean {
  const foldedName = fold(name);
  const foldedPattern = fold(pattern);
  return foldedPattern.endsWith("*") ? foldedName.startsWith(foldedPattern.slice(0, -1)) : foldedName === foldedPattern;
}

export function isNeverPassed(name: string, denylist: readonly string[], platform: NodeJS.Platform): boolean {
  const upper = name.toUpperCase();
  if (NEVER_PASSED_PREFIXES.some((prefix) => upper.startsWith(prefix))) {
    return true;
  }
  const fold = platform === "win32" ? (value: string): string => value.toUpperCase() : (value: string): string => value;
  return denylist.some((pattern) => matchesPattern(name, pattern, fold));
}

export function buildChildEnv(options: ChildEnvOptions): Record<string, string> {
  const fold = options.platform === "win32" ? (value: string): string => value.toUpperCase() : (value: string): string => value;
  const denylist = options.denylist ?? [];
  const allowed = [...ALLOWED_NAMES, ...(options.passthrough ?? [])];
  const entries = new Map<string, readonly [string, string]>();

  const put = (name: string, value: string): void => {
    entries.set(fold(name), [name, value]);
  };

  for (const [name, value] of Object.entries(options.baseEnv)) {
    if (value === undefined || isNeverPassed(name, denylist, options.platform)) {
      continue;
    }
    if (allowed.some((pattern) => matchesPattern(name, pattern, fold))) {
      put(name, value);
    }
  }
  for (const [name, value] of Object.entries(options.extra ?? {})) {
    if (!isNeverPassed(name, denylist, options.platform)) {
      put(name, value);
    }
  }
  for (const [name, value] of Object.entries(DEFAULTS)) {
    if (!entries.has(fold(name))) {
      put(name, value);
    }
  }
  for (const [name, value] of Object.entries({ ...FORCED, ...(options.additionalForced ?? {}) })) {
    put(name, value);
  }
  if (options.platform === "win32") {
    put("NoDefaultCurrentDirectoryInExePath", "1");
  }
  return Object.fromEntries(entries.values());
}

export function getEnvValue(env: EnvMap, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") {
    return env[name];
  }
  const wanted = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === wanted) {
      return value;
    }
  }
  return undefined;
}
