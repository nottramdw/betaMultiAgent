# betaMultiAgent

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A multi-agent development environment for Claude and Grok models. Agents, tools and skills are written in TypeScript on Node.js; the `bma` command-line tool runs a single agent or a small team (lead, executor, reviewer, researcher) against a local repository. Self-contained binaries are built with a Rust packager.

> **Status:** early development (0.x). Interfaces, configuration keys and the on-disk session format may change without notice. No release has been published yet.

This project is not affiliated with or endorsed by xAI, Anthropic or Anysphere. The names Claude, Grok and Cursor are used only to describe compatibility.

## Features

- **Providers:** Claude through the Messages API and Grok through the xAI Responses API, behind one provider interface.
- **Team runs:** a lead plans, an executor edits in an isolated git worktree on branch `bma/<runId>`, approved verification commands run, and a reviewer approves, requests a revision or blocks; changes to sensitive files stop the run for human review.
- **Permission policy:** every file write and command passes a rule engine with hard denies, default deny and interactive approval. There is no OS sandbox; read [docs/security-model.md](docs/security-model.md) before use.
- **Skills and plugins:** reads skills from `.claude-plugin`, `.cursor-plugin` and `.grok-plugin` manifests. Cursor support is limited to the `.cursor-plugin` manifest format.
- **Platforms:** macOS and Windows (Linux is exercised in CI for the TypeScript and Rust gates).

## Requirements

- Node.js `^22.18.0 || ^24.0.0 || >=26.0.0` (Node 25 is not supported).
- pnpm 10.34.9: `corepack enable` (Corepack is bundled up to Node 24), or `npm i -g pnpm@10.34.9` on Node 25 and later.
- git, for team runs.
- Rust stable, only to build the standalone binary.

Release binaries target macOS on Apple silicon (arm64) and Windows x64 and need no Node.js installation.

## Quick start

```sh
pnpm install --frozen-lockfile
pnpm build
node packages/cli/bin/bma.js doctor
```

Provider keys are read from the environment only: `ANTHROPIC_API_KEY` for Claude, `XAI_API_KEY` for Grok. Use keys with spending limits.

```sh
bma doctor
bma models
bma run "Summarize the build scripts in this repository" --model claude:claude-sonnet-5-5
bma run --prompt-file task.md --role researcher --json
bma trust
bma team "Add a --verbose flag to the CLI and cover it with a test" --max-cost 2
bma team clean <runId> --delete-branch --yes
bma sessions prune --older-than 30
```

`bma` above stands for `node packages/cli/bin/bma.js` or a packaged binary. A workspace is untrusted until `bma trust` records it; until then project instructions, repository skills, project settings other than deny/ask rules, exec allow rules and verification approval are ignored. Editing `bma.config.json` revokes trust.

Exit codes: `0` ok, `1` failed, `2` usage or configuration error, `3` budget exceeded, `4` refused, blocked or needs human review, `130` interrupted.

## Building the binary

```sh
pnpm install --frozen-lockfile
cargo run -p bma-packager --release -- build --out dist/bin
```

The packager bundles the CLI with esbuild, embeds it into a Node.js single executable application, signs it ad-hoc on macOS, smoke-tests it and writes `THIRD_PARTY_LICENSES.txt`. `--official-node` embeds the official Node.js build after verifying `SHASUMS256.txt` against the pinned release keys. Binaries are not code-signed; Windows SmartScreen and macOS Gatekeeper may warn on first run.

## Documentation

| Document | Content |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | Packages, agent loop, provider mapping, team flow, packaging. |
| [docs/security-model.md](docs/security-model.md) | Permission policy, trust, redaction and the limits of the model. |
| [docs/configuration.md](docs/configuration.md) | `bma.config.json`, platform directories, environment variables. |
| [docs/development.md](docs/development.md) | Toolchain, quality gates, supply chain, CI. |
| [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) | Dependencies and their licenses. |

## Repository structure

```text
.
├── .github/workflows/      # CI and release
├── packages/
│   ├── core/               # Agent loop, permissions, sessions, team orchestration
│   ├── providers/
│   │   ├── claude/         # Claude Messages API adapter
│   │   └── grok/           # xAI Responses API adapter
│   ├── tools/              # File, search and process tools; git repository operations
│   ├── skills/             # Skill discovery and plugin manifests
│   └── cli/                # bma command-line tool
├── crates/packager/        # Builds the standalone binary
├── scripts/                # Quality gates, bundling and license collection
└── docs/
```

## Roadmap

- [x] Core runtime: agent loop, permissions, sessions
- [x] Claude and Grok providers
- [x] Tools, skills and plugin manifests
- [x] Command-line interface and team orchestration
- [x] Rust packager for single-binary distribution
- [ ] First tagged release

## Contributing

Issues and pull requests are welcome. For significant changes, open an issue first. See [docs/development.md](docs/development.md) for the required checks.

## License

Released under the [MIT License](LICENSE).
