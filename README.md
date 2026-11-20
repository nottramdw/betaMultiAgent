# betaMultiAgent

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A provider-agnostic multi-agent framework. Agents, tools, and skills are written in TypeScript on Node.js; distribution artifacts are built with Rust.

> **Status:** early development. APIs and directory layout may change without notice.

## Goals

- Coordinate multiple cooperating agents through a single orchestration layer.
- Keep agent logic independent of the underlying model provider.
- Support **Claude** as the first provider, followed by **Grok**.
- Treat tools and skills as composable, independently testable units.
- Ship self-contained binaries that do not require a preinstalled Node.js toolchain.

## Core Concepts

| Concept | Responsibility |
| --- | --- |
| **Agent** | An autonomous unit with a role, instructions, and a set of tools and skills. |
| **Orchestrator** | Schedules agents, routes messages between them, and aggregates results. |
| **Provider** | Adapter that maps the common agent interface onto a specific model API. |
| **Tool** | A typed, side-effecting capability an agent can invoke. |
| **Skill** | A reusable bundle of instructions and tools for a recurring task. |

## Repository Structure

```text
.
├── .github/
│   └── workflows/          # Continuous integration
├── packages/               # TypeScript workspace
│   ├── core/               # Agent runtime, orchestrator, messaging, shared types
│   ├── providers/
│   │   ├── claude/         # Anthropic Claude adapter
│   │   └── grok/           # xAI Grok adapter
│   ├── tools/              # Tool implementations
│   ├── skills/             # Skill definitions
│   └── cli/                # Command-line entry point
├── crates/                 # Rust workspace
│   └── packager/           # Builds distributable binaries
├── examples/               # Runnable usage examples
├── docs/                   # Architecture and design documents
├── scripts/                # Development and release scripts
├── LICENSE
└── README.md
```

## Technology Stack

| Layer | Technology |
| --- | --- |
| Agents, tools, skills | TypeScript, Node.js |
| Package management | pnpm workspaces |
| Packaging and distribution | Rust, Cargo |

## Prerequisites

- Node.js 22 or later
- pnpm 9 or later
- Rust stable toolchain

Installation and usage instructions will be added once the first packages are released.

## Roadmap

- [ ] Core runtime: agent lifecycle, message bus, orchestrator
- [ ] Claude provider
- [ ] Tool and skill interfaces with a reference set
- [ ] Command-line interface
- [ ] Rust packager for single-binary distribution
- [ ] Grok provider

## Contributing

Issues and pull requests are welcome. For significant changes, please open an issue first to discuss the proposed design.

## License

Released under the [MIT License](LICENSE).
