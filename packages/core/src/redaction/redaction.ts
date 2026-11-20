export const REDACTED = "[REDACTED]";
export const MIN_SECRET_LENGTH = 8;

const TOKEN_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu,
  /sk-ant-[A-Za-z0-9_-]{8,}/gu,
  /xai-[A-Za-z0-9_-]{16,}/gu,
  /github_pat_[A-Za-z0-9_]{20,}/gu,
  /gh[pousr]_[A-Za-z0-9]{20,}/gu,
  /AKIA[0-9A-Z]{16}/gu,
];

export interface Redactor {
  redact(text: string): string;
  redactValue<T>(value: T): T;
}

export interface RedactorOptions {
  readonly secrets?: readonly string[];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function createRedactor(options: RedactorOptions = {}): Redactor {
  const secrets = [...new Set(options.secrets ?? [])]
    .filter((secret) => secret.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);
  const secretPattern = secrets.length === 0 ? undefined : new RegExp(secrets.map(escapeRegExp).join("|"), "gu");

  const redact = (text: string): string => {
    let out = secretPattern === undefined ? text : text.replace(secretPattern, REDACTED);
    for (const pattern of TOKEN_PATTERNS) {
      out = out.replace(pattern, REDACTED);
    }
    return out;
  };

  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      return redact(value);
    }
    if (Array.isArray(value)) {
      return value.map(walk);
    }
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, walk(inner)]));
    }
    return value;
  };

  return {
    redact,
    redactValue<T>(value: T): T {
      return walk(value) as T;
    },
  };
}
