# Configuration

Reference for configuring the `bma` CLI: configuration files, merge rules, platform directories, environment variables, command flags, and model selection. Behavior described here is taken from the implementation; where the CLI is ambiguous, the source files linked below are authoritative.

Verified against source: 2026-11-20.

## Contents

- [Configuration files](#configuration-files) - lookup locations, merge order, trust effects
- [Schema](#schema) - every configuration key, validation rules
- [Example](#example) - complete annotated file
- [Method skill plugin](#method-skill-plugin) - bundled working-method skills and how to load them
- [Platform directories](#platform-directories) - config, state and data locations
- [Environment variables](#environment-variables) - provider keys, paths, child-process environment
- [Commands](#commands) - flags, positionals and exit codes per command
- [Model selection](#model-selection) - model reference format, catalog, role defaults

Related documents: [Security model](./security-model.md) (implications of trust, passthrough and permission rules), [Architecture](./architecture.md).

## Configuration files

| Scope | Path | Read by | Notes |
|-------|------|---------|-------|
| User | `<config dir>/config.json` | every command that opens a workspace | Directory depends on platform, see [Platform directories](#platform-directories). |
| Project | `<workspace root>/bma.config.json` | every command that opens a workspace | Workspace root is the real path of the current directory. Parent directories are not searched. |

The workspace root is refused when it is the home directory, a file system root, or contains a bma state or configuration directory ([`resolveWorkspaceRoot`](../packages/cli/src/config/paths.ts)). Run `bma` from the project directory itself.

A missing file is treated as empty. A file that exists but is unreadable, is not valid JSON, or fails validation stops the command with exit code 2 (see [Validation](#validation)).

### Merge order and precedence

Sources are combined in [`mergeConfig`](../packages/cli/src/config/merge.ts). The project file is applied only when the workspace is trusted, except where noted.

| Key | User file | Project file, trusted | Project file, not trusted |
|-----|-----------|-----------------------|---------------------------|
| `roles` | applied | merged per field: a project `model` replaces the user `model` and `effort` together; `instructions` and `maxTurns` from the project replace the user values; `maxCostUsd` is the lower of the two | ignored |
| `permissions.rules` | applied | appended after user rules | only `deny` and `ask` rules are kept |
| `budget` | applied | per field, the lower value wins; `dailyMaxCostUsd` is ignored with a warning | ignored |
| `env.passthrough` | applied | union with user list | ignored |
| `skills.extraRoots` | applied | ignored, warning printed | ignored, warning printed |
| `team.setup` | applied only when trusted and the project file has no `team.setup` | applied; replaces the user value | ignored; no setup commands run, including user-level ones |
| `audit` | applied | ignored, warning printed | ignored, warning printed |

Other sources, in relation to the file values:

| Source | Effect |
|--------|--------|
| `bma run --model <provider:id>` | Replaces the model for the run. Does not set `effort`; `maxTurns` and `instructions` from `roles` still apply. |
| `bma run --role <role>` | Selects the role whose configuration is applied. Default `executor`. |
| `bma team --max-cost <usd>` | Adds a cost limit. The effective limit is the lower of this value and `budget.maxCostUsd`. |
| `ANTHROPIC_API_KEY`, `XAI_API_KEY` | Required for the matching provider. Never read from configuration files. |
| `ANTHROPIC_BASE_URL`, `XAI_BASE_URL` | Override the API host. Not configurable in files. |
| `BMA_HOME`, `XDG_*`, `APPDATA`, `LOCALAPPDATA` | Select directories only. |

Role model resolution, highest first: `--model` flag (run only), then `roles.<role>.model` from the merged configuration, then the built-in default in [Model selection](#model-selection).

### Trust

A project file can change behavior that a cloned repository should not control silently. The workspace is therefore untrusted until the user grants trust with `bma trust`.

- Trust is stored in `<state dir>/trust.json`, keyed by the workspace root path.
- Trust is bound to the SHA-256 of the raw bytes of `bma.config.json`. Editing the file, or creating it after trust was granted, revokes trust. A missing file has the digest of an empty input.
- `bma trust` shows what trust activates, then asks for confirmation. It requires an interactive terminal.
- `bma trust --revoke` removes trust without a terminal.

Untrusted workspaces also disable the project instruction files listed in [`system-prompt.ts`](../packages/core/src/agent/system-prompt.ts) (`PROJECT_CONTEXT_FILES`), repository skill directories (`.bma/skills`, `.claude/skills`, `.agents/skills`), and verification approval. See [Security model](./security-model.md).

Trust logic: [`trust.ts`](../packages/cli/src/config/trust.ts).

## Schema

Source: [`schema.ts`](../packages/cli/src/config/schema.ts). Every object is strict: unknown keys are rejected. Keys are case-sensitive.

| Key | Type | Default | Meaning |
|-----|------|---------|---------|
| `roles` | object | built-in per role | Per-role overrides. Keys: `lead`, `executor`, `reviewer`, `researcher`. All optional. |
| `roles.<role>.model` | string | built-in model for the role | Model reference `<provider>:<model-id>`, provider `claude` or `grok`. See [Model selection](#model-selection). |
| `roles.<role>.effort` | `low` \| `medium` \| `high` \| `xhigh` \| `max` | not set | Reasoning effort. The model must support it (checked at runtime). |
| `roles.<role>.instructions` | non-empty string | none | Appended to the built-in role instructions, which keep the completion-tool protocol. |
| `roles.<role>.maxTurns` | positive integer | `lead` 40, `researcher` 30, `executor` 120, `reviewer` 40 | Maximum model turns for the role. |
| `roles.<role>.maxCostUsd` | positive number | not set | Cost cap for the role in a team run. The researcher cap covers all delegations together. Reaching it stops the run with `budget-exceeded` (`budget-role`). |
| `permissions` | object | none | Permission policy. Only `rules` is accepted. |
| `permissions.rules` | array | `[]` | Rules, evaluated as described below. |
| `permissions.rules[].kind` | `read` \| `write` \| `exec` | required | Operation the rule applies to. |
| `permissions.rules[].match` | string (`read`, `write`) or string array (`exec`) | required | Path glob, or argv prefix for `exec`. |
| `permissions.rules[].decision` | `allow` \| `ask` \| `deny` | required | Outcome when the rule matches. |
| `budget` | object | none | Limits applied to every run. |
| `budget.maxCostUsd` | positive number | not set (no cost limit) | Maximum cost in US dollars. |
| `budget.maxWallMinutes` | positive integer | not set (no time limit) | Maximum wall-clock time in minutes. |
| `budget.dailyMaxCostUsd` | positive number | not set (no daily limit) | Maximum total cost per UTC day across every project that shares the state directory. Honored only in the user file. See [Daily cost cap](#daily-cost-cap). |
| `env` | object | none | Child-process environment settings. |
| `env.passthrough` | array of strings | `[]` | Additional environment variable names passed to child processes. See [Child-process environment](#child-process-environment). |
| `skills` | object | none | Skill settings. |
| `skills.extraRoots` | array of absolute path strings | `[]` | Extra skill directories. Honored only in the user file. |
| `team` | object | none | Team run settings. |
| `team.setup` | array of argv arrays | `[]` | Commands run in the team worktree before work starts. Each element is an array of one or more strings, run without a shell. |
| `audit` | object | none | Audit ledger settings. Honored only in the user file. |
| `audit.retentionDays` | integer, at least 30 | `180` | Month files of the audit ledger older than this many days are deleted when a run opens the ledger. |

### Permission rule semantics

Source: [`permission-engine.ts`](../packages/core/src/permissions/permission-engine.ts), [`exec-policy.ts`](../packages/core/src/permissions/exec-policy.ts).

- Path rules (`read`, `write`) match paths inside the workspace root. Patterns use picomatch with dotfiles included, matched against the path relative to the root.
- When several rules match, the strictest decision applies: `deny` over `ask` over `allow`.
- Exec rules compare the program name (directory and extension removed) and then the arguments. Without a trailing `*`, the arguments must match exactly. A trailing `*` allows any further arguments.
- `*` is allowed only as the last token, and cannot be the program. Prefix rules are rejected for runners such as `git`, `npm`, `npx`, `pnpm`, `yarn`, `bun` and `bunx`; list their exact argv.
- `ask` requires an approver. In an interactive terminal (standard input and standard error are terminals, and `--json` is not set), the user is prompted. Otherwise the request is denied.
- Built-in hard denials apply regardless of rules: bma state files (including `trust.json`) are not accessible to agents, and bma configuration is not writable by agents.
- Exec rule shape errors are detected when the permission engine is created at the start of `run` or `team`, and exit 1, not 2.

### Daily cost cap

Source: [`daily-spend.ts`](../packages/cli/src/budget/daily-spend.ts), [`run-budget.ts`](../packages/cli/src/budget/run-budget.ts).

- The ledger is one JSON Lines file per UTC day in `<state dir>/spend/`, for example `2026-11-23.jsonl`. Every write holds the lock file `<state dir>/spend/spend.lock`.
- `bma run`, `bma team`, each panel candidate and each task started by `bma task run` reserve budget before the first model request. The reservation is the lower of the run limit and the remaining daily amount, or the remaining amount when no run limit is set. It becomes the run's cost limit.
- Remaining amount: the cap minus recorded spend minus the unspent part of open reservations. Reservations of processes on the same host that no longer run are not counted; their recorded spend still is.
- Spend is recorded after each model response. The reservation is released when the run ends. Within a run, the limit is checked once per turn, so a run can exceed its reservation by one response.
- When nothing remains, the command exits 3 before any model request. A task refused this way stays `open`, with code `budget` in its history.
- `bma team --candidates <n>` without a run limit gives each candidate the remaining amount divided by `n`. Judge costs are recorded after each judge call; a judge is skipped, and the candidate cannot be selected, when nothing remains.
- An unreadable ledger, or a lock held for more than 10 seconds, stops the run with exit 1 and names the file.
- `bma eval` runs with its own temporary state directory and its required `--max-cost`; the daily cap does not apply to it.

## Validation

Validation runs in [`parseConfigText`](../packages/cli/src/config/load.ts) when the file is loaded.

| Rule | Behavior |
|------|----------|
| Invalid JSON | Exit 2: `<file>: invalid JSON (...)`. A UTF-8 byte order mark is accepted. |
| Credentials | Exit 2 if any key name anywhere in the file matches, case-insensitively: `api-key`, `apikey`, `api_key`, `token`, `secret`, `password`, `passwd`, `credential`, `private-key`, `private_key`, `auth`. The message lists the offending paths and asks for environment variables instead. |
| Unknown keys | Exit 2 with the schema error. Applies to every strict object: top-level, `roles`, role objects, `permissions`, `budget`, `env`, `skills`, `team`, `audit`. |
| Model reference | Must match `^(claude\|grok):[A-Za-z0-9][A-Za-z0-9._-]*$`. Whether the model exists in the catalog is checked when the model is used. |
| Passthrough names | Must match `^[A-Z_][A-Z0-9_]*$` and must not be a denied name. Exit 2 otherwise. |
| Budget and turns | `maxCostUsd` and `dailyMaxCostUsd` must be positive; `maxWallMinutes` and `maxTurns` must be positive integers. |
| Audit retention | `audit.retentionDays` must be an integer of at least 30. |

Credentials belong in environment variables. The configuration cannot hold them, and the CLI redacts the values of `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `XAI_API_KEY` from its output.

`bma doctor` reports configuration errors as an `error` check and exits 1 instead of 2.

## Example

Complete file with every key. `skills` is effective only in the user file; in a project file it is ignored with a warning. The project file takes effect only after trust is granted. JSON does not allow comments; the notes follow the example.

```json
{
  "roles": {
    "lead": { "model": "claude:claude-opus-5-5", "effort": "high", "maxTurns": 40 },
    "executor": { "model": "claude:claude-sonnet-5-5", "maxTurns": 120 },
    "reviewer": { "model": "grok:grok-4.7", "effort": "medium" },
    "researcher": {
      "model": "claude:claude-haiku-5-5",
      "instructions": "Answer with file paths for every claim."
    }
  },
  "permissions": {
    "rules": [
      { "kind": "write", "match": "src/**", "decision": "allow" },
      { "kind": "write", "match": "dist/**", "decision": "deny" },
      { "kind": "read", "match": ".env*", "decision": "deny" },
      { "kind": "exec", "match": ["npm", "test"], "decision": "allow" },
      { "kind": "exec", "match": ["git", "push", "--force"], "decision": "deny" }
    ]
  },
  "budget": {
    "maxCostUsd": 5,
    "maxWallMinutes": 60
  },
  "env": {
    "passthrough": ["JAVA_HOME"]
  },
  "skills": {
    "extraRoots": ["/opt/team-skills"]
  },
  "team": {
    "setup": [["npm", "ci"]]
  }
}
```

Notes:

- `effort` values must be supported by the chosen model. Grok models accept `low` to `xhigh`; `max` is Claude only.
- On Windows, an absolute `extraRoots` entry uses a drive path such as `"C:\\team-skills"`. Relative entries are skipped with a warning.
- A `team.setup` entry is an argv array. It is not passed through a shell.

## Method skill plugin

The repository ships eight working-method skills in [`plugins/bma-method`](../plugins/bma-method). They are not installed automatically. Load them in one of two ways:

| Method | Steps | Effect |
|---|---|---|
| Plugin directory | Copy `plugins/bma-method` to `<config>/plugins/bma-method`. A symlink or junction is skipped. | The manifest is read; `bma doctor` reports one plugin; skills have origin `plugin:bma-method`. |
| Extra root | Set `skills.extraRoots` in the user file to the absolute path of `<repo>/plugins/bma-method/skills`. | Skills are scanned directly; the manifest is not read. |

| Skill | Purpose | Command and role |
|---|---|---|
| `bma-working-principles` | Route, baseline, change, verify, review, return; trace code, confirm reasons, label inference. | Any |
| `bma-explain-mechanics` | Trace current behavior from an entry point to its effects. | `bma run`; lead or researcher in `bma team` |
| `bma-explain-rationale` | Explain design reasons from git history and documents. | `bma run`; `git` asks for approval unless an exact `exec` rule matches; otherwise files only |
| `bma-teach-codebase` | Combine the two explanation skills for onboarding. | `bma run` |
| `bma-design-boundaries` | Fix types, signatures and module ownership in the plan. | `bma team`; lead |
| `bma-encode-correction` | Turn a recurring mistake into a constraint: architecture, then types/lint/CI, then tests, then written rules. | `bma team`; lead and executor |
| `bma-benchmark-checklist` | Check that a measurement supports its claim; Windows variant included. | `bma run` or `bma team` reviewer |
| `bma-create-verification-skill` | Write a repository skill with launch, doctor, drive, capture and cleanup sections. | `bma team`; executor |

Notes:

- Read-only team roles have `read_file`, `glob`, `grep` and the skill tools only. The three explanation skills work best in `bma run`.
- A skill with the same name in a repository skill directory (`.bma/skills`, `.claude/skills`, `.agents/skills`) wins over the plugin when the workspace is trusted; a duplicate warning is printed. User skills in `<config>/skills` win over plugin skills.
- Plugins written for other agents load only their skills. `agents`, `hooks`, `commands`, `mcpServers` and `lspServers` are ignored with a warning. There is no parallel fan-out: subagent tasks map to `delegate` (read-only researcher) or run sequentially.

## Platform directories

Source: [`resolveDirs`](../packages/cli/src/config/paths.ts). Platform is taken from `process.platform`.

| Platform | State dir | Config dir | User config file |
|----------|-----------|------------|------------------|
| Windows | `%LOCALAPPDATA%\betaMultiAgent` (fallback `<home>\AppData\Local\betaMultiAgent`) | `%APPDATA%\betaMultiAgent` (fallback `<home>\AppData\Roaming\betaMultiAgent`) | `%APPDATA%\betaMultiAgent\config.json` |
| macOS | `~/Library/Application Support/betaMultiAgent/state` | `~/Library/Application Support/betaMultiAgent/config` | `~/Library/Application Support/betaMultiAgent/config/config.json` |
| Linux and other | `$XDG_STATE_HOME/betaMultiAgent` (default `~/.local/state/betaMultiAgent`) | `$XDG_CONFIG_HOME/betaMultiAgent` (default `~/.config/betaMultiAgent`) | `$XDG_CONFIG_HOME/betaMultiAgent/config.json` |

Override with `BMA_HOME`, which takes precedence on every platform:

| Directory | Path |
|-----------|------|
| State | `<BMA_HOME>/state` |
| Config | `<BMA_HOME>/config` |
| User config file | `<BMA_HOME>/config/config.json` |

`BMA_HOME` is resolved to an absolute path. An empty value is treated as unset. `XDG_*` variables are read only on Linux and other non-Windows, non-macOS platforms; `APPDATA` and `LOCALAPPDATA` only on Windows.

### Contents of the state directory

| Path | Contents |
|------|----------|
| `<state>/projects/<key>/sessions/<ulid>/` | Session event logs for `bma run` and team role sessions. |
| `<state>/projects/<key>/runs/<ulid>/` | Team run records and `hooks/`. |
| `<state>/projects/<key>/audit/<YYYY-MM>.jsonl` | Audit ledger, one file per UTC month. |
| `<state>/projects/<key>/tasks/tasks.jsonl` | Task store, an append-only event log. |
| `<state>/projects/<key>/tasks/runner.lock` | Lock held by `bma task run`. |
| `<state>/worktrees/<runId>/` | Git worktree for a team run. |
| `<state>/trust.json` | Trust grants. |

`<key>` is the first 16 hex characters of the SHA-256 of the workspace root path. Team branches are named `bma/<runId>`.

### Audit ledger

Source: [`audit-ledger.ts`](../packages/cli/src/audit/audit-ledger.ts), [`audit-recorder.ts`](../packages/cli/src/audit/audit-recorder.ts).

`bma run` and `bma team` append redacted JSON lines to the audit ledger. Each record has `v`, `ts`, `runId` and `kind`. For `bma run`, `runId` is the session id.

| `kind` | Fields |
|--------|--------|
| `run-start` | `command`; `taskId` when started by `bma task run`; `roles` with `model` and `effort` per role (`provider-default` when not set); `budget`; `taskSha256`; `taskPrefix` (first 80 characters). |
| `permission` | `role`, `sessionId`, `action` (`read`, `write`, `exec`), `target` (paths relative to the workspace root; argv truncated to 16 tokens of 120 characters), `allowed`, `source`, `approval`. |
| `run-outcome` | `status`, `code`, `revisions`, `planCorrections`, `invalidInputs`, `usage`, `usageByRole`, `verification`, `approvedCommands` and `unapprovedCommands` with `source` (`tty`, `yes-verify`, `rule`, `untrusted-skip`, `not-approved`), `commit`, `branch`. |

- Files are created with mode `0600` in a directory with mode `0700`.
- A write error prints one warning and disables the ledger for the run; the run continues.
- `bma sessions prune`, `bma team clean` and `bma task` do not touch the ledger. Retention is set by `audit.retentionDays`.

Directories are created with mode `0700` (on non-Windows platforms). `bma doctor` warns when the state directory is accessible to other users, and when `BMA_HOME` is outside the user profile.

## Environment variables

### Provider and endpoint variables

| Variable | Used by | Meaning |
|----------|---------|---------|
| `ANTHROPIC_API_KEY` | `claude:*` models | Required to use any Claude model. Also enables the `claude` provider for default team roles. |
| `XAI_API_KEY` | `grok:*` models | Required to use any Grok model. Also enables the `grok` provider for default team roles. |
| `ANTHROPIC_BASE_URL` | Claude provider | Overrides the API host. Default `https://api.anthropic.com`. |
| `XAI_BASE_URL` | Grok provider | Overrides the API host. When unset, the client library default is used. |
| `ANTHROPIC_AUTH_TOKEN` | Redaction only | Not used for requests by bma. Its value is redacted from output. `bma doctor` reports whether it is set. |
| `ANTHROPIC_CUSTOM_HEADERS` | `bma doctor` | Only header names are displayed. bma does not use it for requests. |
| `XAI_DEBUG` | `bma doctor` | Presence produces a warning that SDK debug logs may contain request details. |

Sources: [`wiring.ts`](../packages/cli/src/wiring.ts), [`claude/provider.ts`](../packages/providers/claude/src/provider.ts), [`grok/provider.ts`](../packages/providers/grok/src/provider.ts), [`doctor.ts`](../packages/cli/src/commands/doctor.ts).

Empty or whitespace-only values count as unset. A missing key stops the command with exit 2 and a message naming the variable. Values of the credential variables are redacted from command output and session logs, and key values must not be placed in configuration files.

### Path variables

| Variable | Effect |
|----------|--------|
| `BMA_HOME` | Single root for state and configuration. See [Platform directories](#platform-directories). |
| `LOCALAPPDATA`, `APPDATA` | Windows state and config roots. |
| `XDG_STATE_HOME`, `XDG_CONFIG_HOME` | Linux state and config roots. |

No other `BMA_*` variable is read.

### Child-process environment

Commands run by agents (`exec` tool, verification and setup commands, and git) receive a filtered environment built by [`buildChildEnv`](../packages/tools/src/process/child-env.ts). Variables not listed below are not passed.

Passed by name when present:

`PATH`, `PATHEXT`, `SystemRoot`, `SystemDrive`, `windir`, `ComSpec`, `TEMP`, `TMP`, `TMPDIR`, `HOME`, `USERPROFILE`, `USERNAME`, `USER`, `LOGNAME`, `SHELL`, `APPDATA`, `LOCALAPPDATA`, `LANG`, `TERM`, and every variable whose name starts with `LC_`.

Set by bma in every child process:

| Variable | Value |
|----------|-------|
| `GIT_TERMINAL_PROMPT` | `0` |
| `GIT_PAGER` | `cat` |
| `PAGER` | `cat` |
| `NO_COLOR` | `1` |
| `BMA_AGENT_CHILD` | `1` |
| `PYTHONUTF8` | `1` (only if not already present) |
| `PYTHONIOENCODING` | `utf-8` (only if not already present) |
| `NoDefaultCurrentDirectoryInExePath` | `1` (Windows only) |

Never passed, even if listed in `env.passthrough`: any name starting with `ANTHROPIC_` or `XAI_`.

On Windows, name matching is case-insensitive.

#### Extending the passthrough list

Add exact variable names to `env.passthrough` in the user file (always effective) or in the project file (effective only when trusted).

```json
{ "env": { "passthrough": ["JAVA_HOME", "GOPATH"] } }
```

Names are validated when the file is loaded. Rejected names:

| Category | Examples |
|----------|----------|
| Not matching `^[A-Z_][A-Z0-9_]*$` | `lower`, `GITHUB-TOKEN` |
| Loader and interpreter control | `NODE_OPTIONS`, `NODE_PATH`, `NODE_EXTRA_CA_CERTS`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `PYTHONPATH`, `PYTHONSTARTUP`, `PERL5OPT`, `RUBYOPT`, `BASH_ENV`, `ENV`, `PROMPT_COMMAND` |
| Git program control | `GIT_SSH`, `GIT_SSH_COMMAND`, `GIT_ASKPASS`, `SSH_ASKPASS`, `GIT_EXEC_PATH`, and any name starting with `GIT_CONFIG` |
| macOS loader | any name starting with `DYLD_` |
| bma and provider prefixes | `BMA_*`, `ANTHROPIC_*`, `XAI_*` |
| Credential suffixes | `*_TOKEN`, `*_SECRET`, `*_KEY`, `*_PASSWORD`, `*_CREDENTIALS` |

Source of the denied list: [`passthrough.ts`](../packages/cli/src/config/passthrough.ts). Passthrough values are forwarded as they are; a variable that holds a credential should not be passed through.

## Commands

Global options:

| Invocation | Behavior | Exit |
|------------|----------|------|
| `bma --help`, `bma -h`, `bma help` | Prints help. | 0 |
| `bma` (no arguments) | Prints help. | 2 |
| `bma --version`, `bma -v` | Prints the version. | 0 |
| `bma <command> --help` | Prints help. | 0 |
| `<command> --json` | Writes JSON lines to standard output. Console output from libraries is redirected to standard error. | per command |

Command dispatch: [`main.ts`](../packages/cli/src/main.ts). Argument parsing uses `node:util` `parseArgs` in strict mode, so unknown flags are usage errors.

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Failure |
| 2 | Usage or configuration error |
| 3 | Budget exceeded |
| 4 | Refused, blocked, or needs human review |
| 130 | Interrupted |

Source: [`cli-error.ts`](../packages/cli/src/cli-error.ts).

### `bma run`

```
bma run [--prompt <text> | --prompt-file <file> | <text>] [--model provider:id] [--role <role>] [--json]
```

| Option | Short | Type | Default | Meaning |
|--------|-------|------|---------|---------|
| `--prompt` | `-p` | string | | Prompt text. |
| `--prompt-file` | `-f` | string | | Read the prompt from a file (UTF-8, UTF-8 with BOM, or UTF-16 with BOM). |
| `--model` | `-m` | string | role default | Model reference, see [Model selection](#model-selection). |
| `--role` | | `lead`, `executor`, `reviewer`, `researcher` | `executor` | Role configuration to apply. |
| `--json` | | boolean | false | JSON output. |

The prompt comes from exactly one of `--prompt`, `--prompt-file`, or positional text. If none is given and standard input is not a terminal, the prompt is read from standard input. An empty prompt is a usage error.

Only the `executor` role receives the write-capable tools. Other roles receive only the tools marked read-only.

Exit codes: 0 completed; 1 failed, loop detected, or output token limit reached; 3 budget exceeded; 4 model refused; 130 interrupted.

### `bma team`

```
bma team <task> [--task-file <file>] [--allow-dirty] [--max-cost <usd>] [--yes-verify] [--accept <criterion>]...
         [--candidates <n> [--judge <provider>[:<model>]]...] [--json]
```

| Option | Short | Type | Default | Meaning |
|--------|-------|------|---------|---------|
| `--task-file` | `-f` | string | | Read the task from a file. Cannot be combined with positional text. |
| `--allow-dirty` | | boolean | false | Allow starting when the repository has uncommitted changes. Without it, the run stops with status `failed`. |
| `--max-cost` | | positive number | none | Cost limit in US dollars. The lower of this and `budget.maxCostUsd` applies. |
| `--yes-verify` | | boolean | false | Approve verification and setup commands without prompting. Effective only in a trusted workspace. Commands denied by policy still do not run. |
| `--accept` | | string, repeatable | none | Acceptance criterion, kept verbatim. At most 10, each non-empty and at most 500 characters. The lead may add criteria but cannot change these. |
| `--candidates` | | integer 2 to 4 | none | Run a panel of that many independent team runs of the same task; see below. |
| `--judge` | | model, repeatable | none | Judge model for the panel, at most 2, all different. A bare provider means its default `reviewer` model. Requires `--candidates`. |
| `--json` | | boolean | false | JSON output; the final record has type `team-outcome` (with `--candidates`: one per candidate, then `team-panel`). |

The summary lists each criterion with the reviewer assessment (`PASS`, `FAIL`, `NOT_RUN`), the verification status from the harness, and any stop condition or unfinished work reported by the executor. Reviewer and executor statements are claims; only the verification status is produced by the harness.

A team run uses the roles `lead` (plans), `researcher`, `executor` (implements the plan), and `reviewer`. Team changes are made in a git worktree under `<state dir>/worktrees/<runId>`. Verification commands from the plan run only when approved, either interactively or with `--yes-verify`.

Exit codes by status: `approved` 0; `failed` 1; `budget-exceeded` 3; `needs-human` or `blocked` 4; `aborted` 130. Usage errors exit 2.

Panel (`--candidates <n>`):

- The candidates run concurrently with the same configuration. Each has its own run id, worktree and branch `bma/<runId>`, and its own `--max-cost` limit, so the panel may cost up to `n` times that limit plus the judges. No interactive prompts are shown; verification runs only with `--yes-verify`. Ctrl+C stops every candidate.
- With `--judge`, each judge grades every candidate that produced a commit, from the task, the `--accept` criteria, the diff `base..commit` (at most 100 KiB) and the harness verification results. A judge call has a 5-minute timeout and at most 4,000 output tokens.
- The harness selects a candidate only when it is `approved` with a commit, harness verification `passed` with at least one command, every reviewer criterion is `PASS`, there are no sensitive changes, and every judge graded it `pass`. Among those, it prefers fewer revisions, then lower cost, then candidate order. Nothing is merged; the summary lists each candidate with the reasons it was not selected.
- Exit codes: 0 when a candidate is selected; 4 when none is selected but at least one is `approved`; otherwise the exit code of the first candidate's status.

Source: [`team.ts`](../packages/cli/src/commands/team.ts), [`run-team.ts`](../packages/core/src/team/run-team.ts), [`team-panel.ts`](../packages/cli/src/panel/team-panel.ts), [`model-judge.ts`](../packages/cli/src/judge/model-judge.ts).

### `bma team clean`

```
bma team clean <runId> | --all [--delete-branch] [--yes]
```

| Option | Short | Meaning |
|--------|-------|---------|
| `<runId>` | | One run in the current workspace. |
| `--all` | | All runs of the current workspace. Cannot be combined with `<runId>`. |
| `--delete-branch` | | Also delete branch `bma/<runId>`. |
| `--yes` | `-y` | Skip confirmation. Required when standard input or standard error is not a terminal. |

Removes the run's worktree (forced) and run directory. Uncommitted changes in the worktree are listed before removal and are lost. Exit 0 on success, 1 if any removal failed, 2 for usage errors.

Source: [`team-clean.ts`](../packages/cli/src/commands/team-clean.ts).

### `bma task`

```
bma task add <goal> [--goal-file <file>] [--title <text>] [--accept <criterion>]... [--after <id>]... [--parent <id>] [--ask] [--json]
bma task [list [--status <status>] | show <id> | cancel <id>] [--json]
bma task run [<id> | --all [--parallel <n>]] [--allow-dirty] [--max-cost <usd>] [--yes-verify] [--json]
```

A task records a goal for a later run. Tasks are stored per workspace in `<state>/projects/<key>/tasks/tasks.jsonl`; each line is a redacted event (`added` or `status`), and the current state is derived from the events in order. Malformed lines are skipped with a warning. Task ids are ULIDs; commands accept the full id or a unique prefix of at least 4 characters.

| Action | Behavior |
|--------|----------|
| `add` | Adds an `open` task. The goal comes from positional text or `--goal-file` (at most 20,000 characters). |
| `list` (default) | Lists tasks with id, status, mode, title and dependencies. `--status` filters by status. |
| `show <id>` | Prints the task, its dependencies with their status, and the status history with run ids. |
| `cancel <id>` | Sets an `open`, `failed` or `needs-human` task to `cancelled`. |
| `run` | Runs tasks; see below. |

Options of `add`:

| Option | Short | Meaning |
|--------|-------|---------|
| `--goal-file` | `-f` | Read the goal from a file. Cannot be combined with positional text. |
| `--title` | | Title of 1 to 200 characters. Default: the first non-empty line of the goal, cut to 80 characters. |
| `--accept` | | Acceptance criterion, same limits as `bma team --accept`. Stored with the task and immutable. Not allowed with `--ask`. |
| `--after` | | Dependency, repeatable. The task must exist and must not be cancelled. |
| `--parent` | | Parent task, recorded for grouping. It does not affect readiness. |
| `--ask` | | Mode `ask`: answered by a read-only `researcher` session instead of a team run. |

Statuses: `open`, `running`, `done`, `failed`, `needs-human`, `cancelled`. A task is ready when it is `open` and every dependency is `done`.

`bma task run`:

- Without an id, runs the oldest ready task. With `--all`, keeps running ready tasks in order until none is left, a run is interrupted, or the process stops. With an id, runs that task if it is `open`, `failed` or `needs-human` and its dependencies are `done`.
- Mode `team` runs `bma team` with the task goal and acceptance criteria; `--allow-dirty`, `--max-cost` and `--yes-verify` have the same meaning. Mode `ask` runs `bma run --role researcher` with the goal.
- `--parallel <n>` (1 to 4, default 1, requires `--all`) runs up to `n` ready `team` tasks at once, each in its own worktree and branch. When a run ends, tasks that became ready are started. An `ask` task runs alone, once no other run is active. Team runs in parallel mode show no prompts and no event stream: verification runs only with `--yes-verify`, and each run prints its summary (or `team-outcome` record) when it ends. `--max-cost` applies to each run, so concurrent spending can reach `n` times that limit. Ctrl+C stops every run; after an interrupted run, no new task is started. Dependencies only order the runs: a dependent task starts from the current `HEAD`, not from the unmerged branch of its dependency.
- Each run's `run-start` audit record carries `taskId`. The task history records the run id (team run id or session id).
- Only one runner per workspace: `tasks/runner.lock` is created exclusively and holds `pid`, `hostname` and `startedAt`. A lock from a process that no longer exists on the same host is replaced with a warning; any other existing lock is an error (exit 1) that names the lock file. After taking the lock, tasks left `running` by a stopped runner are set to `failed` with code `interrupted`.
- With `--json`, each finished task writes a record of type `task-run` with `taskId`, `status` and `runId`; when no task is ready, one record with `status` `idle`.

| Run result | Task status |
|------------|-------------|
| Team `approved`; ask `completed` | `done` |
| Team `needs-human` or `blocked`; ask `refused` | `needs-human` |
| Team `failed` or `budget-exceeded`; ask failed, loop detected, budget exceeded or output token limit | `failed` |
| `aborted` | `open` |

Exit codes: 0 when every run is `done` or no task is ready; otherwise the exit code of the first run that did not end `done` (as for `bma team` or `bma run`). Usage errors exit 2.

Source: [`task.ts`](../packages/cli/src/commands/task.ts), [`task-store.ts`](../packages/cli/src/tasks/task-store.ts), [`runner-lock.ts`](../packages/cli/src/tasks/runner-lock.ts).

### `bma sessions`

```
bma sessions [list | show <id> | rm <id> | prune [--older-than <days>]] [--json]
```

| Action | Behavior |
|--------|----------|
| `list` (default) | Lists sessions of the current workspace with time, agent, model, outcome and cost. |
| `show <id>` | Prints the event log of one session. |
| `rm <id>` | Removes one session. Refused with exit 1 while a running process holds it. |
| `prune` | Removes sessions older than `--older-than` days (default 30). Sessions in use are skipped. |

Options: `--json` (JSON output) and `--older-than <days>` (non-negative number, `prune` only).

When the first argument is an option, the action defaults to `list`: `bma sessions --json` equals `bma sessions list --json`.

Source: [`sessions.ts`](../packages/cli/src/commands/sessions.ts).

### `bma models`

```
bma models [--provider claude|grok] [--json]
```

Lists the built-in model catalog with context window, maximum output, price per million tokens for the first pricing tier, and supported effort levels. Prints the pricing date for each provider. Unknown provider: exit 2.

Source: [`models.ts`](../packages/cli/src/commands/models.ts).

### `bma doctor`

```
bma doctor [--json]
```

Prints checks with a level (`ok`, `info`, `warn`, `error`): Node.js and platform, `git` availability, key presence (not values), endpoint hosts, state and config directories, workspace trust, configuration validity, instruction files, skill counts, and Windows long-path support. Exits 1 if any check is `error`, otherwise 0.

Source: [`doctor.ts`](../packages/cli/src/commands/doctor.ts).

### `bma trust`

```
bma trust [--revoke]
```

| Option | Behavior |
|--------|----------|
| none | Prints what trust activates (allow and ask rules, setup commands, passthrough, budget, roles, instruction files, repository skills), then asks for confirmation. Requires an interactive terminal; otherwise exit 2 and no change. |
| `--revoke` | Removes trust for the workspace. Does not require a terminal. |

Declining the prompt exits 0 and leaves the workspace untrusted. Trust is bound to the current bytes of `bma.config.json`; see [Trust](#trust).

Source: [`trust.ts`](../packages/cli/src/commands/trust.ts).

### `bma eval`

```
bma eval <suite-dir> --provider claude|grok (--estimate | --max-cost <usd>) [--task <id>]...
         [--variant <file>] [--judge <provider>[:<model>]]... [--repeat <n>] [--max-wall-minutes <n>]
         [--out <file>] [--keep] [--json]
bma eval compare <a.json> <b.json> [--json]
```

| Option | Type | Default | Meaning |
|--------|------|---------|---------|
| `--provider` | `claude`, `grok` | required | Uses the default roles of one provider. |
| `--estimate` | boolean | false | Prints the expected cost from the model catalog and exits. Needs no API key and makes no request. |
| `--max-cost` | positive number | required to run | Cost limit per run in US dollars. The hard cap of the suite is this value times the number of runs. |
| `--variant` | string | none | JSON file that changes the team under test; see below. |
| `--judge` | `claude`, `grok` or `provider:model`, at most 2 | none | Grades each run with a model. A bare provider uses its default reviewer model. Two judges must differ. |
| `--task` | string, repeatable | all tasks | Restricts the run to the given task ids. |
| `--repeat` | positive integer | 1 | Runs each task this many times. |
| `--max-wall-minutes` | positive integer | 20 | Wall-time limit per run. |
| `--out` | string | `<suite>/results/<timestamp>-<provider>[-<variant>].json` | Result file. |
| `--keep` | boolean | false | Keeps each temporary workspace and records its path. |
| `--json` | boolean | false | JSON output; the final record has type `eval-estimate` or `eval-result`. |

A suite directory holds `tasks/*.json`, `fixtures/<name>/` and optional `checks/*.js`. A task has `id`, `kind` (`normal`, `hard-to-verify`, `trap`), `fixture`, `task`, `accept` (acceptance criteria), `expect` (`approved`, `not-approved`), an optional `rubric` (extra criteria shown only to judges), an optional `check` file and an optional `turns` profile for the estimate.

Each run copies the fixture into a new temporary git repository, writes a user configuration with the provider's roles, write access, `node --test` as an allowed command and the budget, grants trust, and runs `bma team --yes-verify --json` in the same process, passing each `accept` entry as `--accept`. The hidden check then runs with Node in the run's worktree, with the base commit as its first argument and without credential variables. A run is correct when an `approved` task is approved and its check passes, or when a `not-approved` task is not approved. The result file contains each run, the per-kind rates, revisions, plan corrections, rejected tool inputs, cost per role, and counts of statuses and codes.

A variant file may set only `roles` and `skills`, with the same shape as the configuration file; any other key is a usage error. Role fields merge over the provider's default roles field by field. Relative `skills.extraRoots` resolve against the variant file. The estimate prices the variant's models, and the result file records the variant name, path and SHA-256.

A judge receives the task, the acceptance criteria (`A1`…) and rubric (`R1`…), the diff from the base commit (cut at 100 KiB) and the harness verification runs; it does not see the hidden check. It must call `submit_grade` once with a verdict (`pass`, `fail`) and one assessment per criterion; `pass` with a `FAIL` criterion is rejected. A judge error is recorded and never changes `correct`. Judge cost is reported apart from team cost; the estimate includes it, and the hard cap adds the judge's worst case per run. The summary gives, per judge, graded, error and skipped counts, the pass rate, accuracy against the hidden check (or against `fail` for `not-approved` tasks without a check), agreement with the reviewer, and, with two judges, their agreement rate.

`bma eval compare` reads two result files and prints the change from A to B for each rate, revisions, harness errors, total cost, cost per run and cost per role, plus the correct runs per task. It makes no request. It warns when the suites, task sets or repeat counts differ. With `--json` the record has type `eval-compare`.

Exit codes: 0 when every run produced a team outcome; 1 when a run failed in the harness; 2 for usage errors. `corepack pnpm bench` runs the bundled suite in `bench/`.

Source: [`eval.ts`](../packages/cli/src/commands/eval.ts), [`eval/`](../packages/cli/src/eval).

## Model selection

### Reference format

`<provider>:<model-id>`, for example `claude:claude-sonnet-5-5` or `grok:grok-4.7`. The provider is `claude` or `grok`. Model IDs must exist in the catalog below; an unknown ID is a usage error (exit 2) when the model is used. No model aliases exist.

Source: [`schema.ts`](../packages/cli/src/config/schema.ts) (`parseModelSpec`), [`wiring.ts`](../packages/cli/src/wiring.ts).

### Catalog

Source: [`claude/models.ts`](../packages/providers/claude/src/models.ts), [`grok/models.ts`](../packages/providers/grok/src/models.ts). Context and output limits are shown as in the catalog.

| Reference | Context window | Max output | Effort levels |
|-----------|----------------|------------|---------------|
| `claude:claude-opus-5-5` | 1,000,000 | 128,000 | low, medium, high, xhigh, max |
| `claude:claude-sonnet-5-5` | 1,000,000 | 128,000 | low, medium, high, xhigh, max |
| `claude:claude-haiku-5-5` | 1,000,000 | 128,000 | low, medium, high, xhigh, max |
| `claude:claude-fable-5-2` | 1,000,000 | 128,000 | low, medium, high, xhigh, max |
| `grok:grok-4.7` | 500,000 | 128,000 | low, medium, high, xhigh |
| `grok:grok-4.3` | 1,000,000 | 128,000 | low, medium, high, xhigh |

Effort is set only through `roles.<role>.effort`. When it is not set, `bma` sends no effort and the provider applies its own default.

### Effort per role

Provider defaults when no effort is sent, per the provider documentation as of 2026-11-23:

| Model | Provider default |
|-------|------------------|
| `claude:claude-opus-5-5` | medium |
| `claude:claude-sonnet-5-5` | high |
| `claude:claude-fable-5-2` | high |
| `claude:claude-haiku-5-5` | not documented |
| `grok:grok-4.7` | high |
| `grok:grok-4.3` | low |

The default roles therefore run the Opus lead and reviewer at `medium`, and a `grok-4.3` researcher or reviewer at `low`. To raise them, set `effort` per role:

```json
{
  "roles": {
    "lead": { "model": "claude:claude-opus-5-5", "effort": "high" },
    "executor": { "model": "claude:claude-sonnet-5-5", "effort": "high" },
    "reviewer": { "model": "grok:grok-4.7", "effort": "high" },
    "researcher": { "model": "grok:grok-4.3", "effort": "medium" }
  }
}
```

Higher effort raises output and reasoning tokens, and therefore cost. The cost difference has not been measured.

### Default models per role

Used when no `roles` entry overrides the role. Source: [`defaultTeamRoles`](../packages/core/src/team/roles.ts).

| Role | Only `ANTHROPIC_API_KEY` | Only `XAI_API_KEY` | Both keys |
|------|--------------------------|--------------------|-----------|
| `lead` | `claude:claude-opus-5-5` | `grok:grok-4.7` | `claude:claude-opus-5-5` |
| `researcher` | `claude:claude-haiku-5-5` | `grok:grok-4.3` | `claude:claude-haiku-5-5` |
| `executor` | `claude:claude-sonnet-5-5` | `grok:grok-4.7` | `claude:claude-sonnet-5-5` |
| `reviewer` | `claude:claude-opus-5-5` | `grok:grok-4.3` | `grok:grok-4.7` |

A role entry without `model` keeps the default model and applies its other fields, including `effort`, to it. When no key is set, there are no defaults. Every role then needs a `roles.<role>.model` entry, or the command fails with exit 2 (`no API key is configured`).

`bma run` without `--role` uses the `executor` default.

## See also

- [Security model](./security-model.md): trust, passthrough and permission implications
- [Architecture](./architecture.md): package layout and runtime components
