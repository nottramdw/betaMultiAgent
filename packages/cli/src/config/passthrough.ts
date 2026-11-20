const NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/u;

const DENIED_NAMES: ReadonlySet<string> = new Set([
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_EXTRA_CA_CERTS",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "GIT_EXEC_PATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PERL5OPT",
  "RUBYOPT",
  "BASH_ENV",
  "ENV",
  "PROMPT_COMMAND",
]);

const DENIED_PREFIXES = ["GIT_CONFIG", "DYLD_", "ANTHROPIC_", "XAI_", "BMA_"];

const DENIED_SUFFIXES = ["_TOKEN", "_SECRET", "_KEY", "_PASSWORD", "_CREDENTIALS"];

export function passthroughProblem(name: string): string | undefined {
  if (!NAME_PATTERN.test(name)) {
    return `${JSON.stringify(name)} is not a valid variable name (expected ${NAME_PATTERN.source})`;
  }
  if (
    DENIED_NAMES.has(name) ||
    DENIED_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
    DENIED_SUFFIXES.some((suffix) => name.endsWith(suffix))
  ) {
    return `${name} cannot be passed through to commands because it can change program behavior or carries credentials`;
  }
  return undefined;
}
