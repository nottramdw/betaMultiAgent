import picomatch from "picomatch";

export const SECRET_PATTERNS: readonly string[] = [
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa*",
  "**/id_dsa*",
  "**/id_ecdsa*",
  "**/id_ed25519*",
  "**/*.p12",
  "**/*.pfx",
  "**/*.jks",
  "**/*.keystore",
  "**/*.kdbx",
  "**/.npmrc",
  "**/.yarnrc.yml",
  "**/.pypirc",
  "**/.netrc",
  "**/_netrc",
  "**/.git-credentials",
  "**/.aws/**",
  "**/.ssh/**",
  "**/.docker/config.json",
  "**/.kube/config",
  "**/*.tfstate",
  "**/*.tfstate.*",
  "**/*.tfvars",
  "**/credentials*.json",
  "**/.dev.vars",
  "**/master.key",
];

export const SECRET_EXCEPTIONS: readonly string[] = ["**/.env.example"];

export const GIT_WRITE_PATTERNS: readonly string[] = ["**/.git", "**/.git/**"];

export const SENSITIVE_WRITE_PATTERNS: readonly string[] = [
  "**/package.json",
  "**/pnpm-lock.yaml",
  "**/package-lock.json",
  "**/npm-shrinkwrap.json",
  "**/yarn.lock",
  "**/bun.lock",
  "**/bun.lockb",
  "**/pnpm-workspace.yaml",
  "**/.yarnrc*",
  "**/.pnpmfile.cjs",
  "**/*.config.*",
  "**/.cargo/**",
  "**/build.rs",
  "**/conftest.py",
  "**/setup.py",
  "**/pyproject.toml",
  "**/Makefile",
  "**/.github/**",
  "**/.gitlab-ci.yml",
  "**/.husky/**",
  "**/.githooks/**",
  "**/.vscode/**",
  "**/.devcontainer/**",
  "**/.envrc",
  "**/.gitattributes",
  "**/.gitmodules",
  "**/AGENTS.md",
  "**/CLAUDE.md",
  "**/.claude/**",
  "**/.agents/**",
  "**/.cursor/**",
  "**/.claude-plugin/**",
  "**/.cursor-plugin/**",
  "**/.grok-plugin/**",
  "**/bma.config.json",
  "**/.bma/**",
];

export type PathMatcher = (relativePosixPath: string) => boolean;

export function compileMatcher(patterns: readonly string[], nocase: boolean): PathMatcher {
  if (patterns.length === 0) {
    return () => false;
  }
  return picomatch([...patterns], { dot: true, nocase });
}

export interface DefaultPathMatchers {
  readonly secret: PathMatcher;
  readonly gitWrite: PathMatcher;
  readonly sensitiveWrite: PathMatcher;
}

export function compileDefaultMatchers(nocase: boolean): DefaultPathMatchers {
  const secrets = compileMatcher(SECRET_PATTERNS, true);
  const exceptions = compileMatcher(SECRET_EXCEPTIONS, true);
  return {
    secret: (path) => secrets(path) && !exceptions(path),
    gitWrite: compileMatcher(GIT_WRITE_PATTERNS, nocase),
    sensitiveWrite: compileMatcher(SENSITIVE_WRITE_PATTERNS, nocase),
  };
}
