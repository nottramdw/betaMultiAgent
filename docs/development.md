# Development

## Requirements

- Node.js `^22.18.0 || ^24.0.0 || >=26.0.0`. Node 25 is not supported (vitest engines); versions before 22.18 lack default TypeScript type stripping, which the check scripts rely on.
- pnpm 10.34.9, pinned through `packageManager`:
  - with Corepack (bundled up to Node 24): `corepack enable`, or run `corepack pnpm@10.34.9 <command>`;
  - without Corepack (Node 25 and later do not bundle it): `npm i -g pnpm@10.34.9`.
- Rust stable (edition 2024) for `crates/packager`.

## Commands

| Command | Purpose |
|---|---|
| `pnpm install --frozen-lockfile` | Install dependencies exactly as locked. |
| `pnpm check:comments` | Reject comments in TS/JS, Rust, TOML, YAML, ignore and rc files; reject non-strict JSON. |
| `pnpm check:deps` | Enforce the internal package graph, SDK ownership and declared imports. |
| `pnpm lint` | ESLint with typescript-eslint `strictTypeChecked`. |
| `pnpm typecheck` | `tsc` over sources, tests and scripts without emitting. |
| `pnpm test` | Vitest; runs sources directly through the `source` export condition. |
| `pnpm build` | `tsc -b` for all packages. |
| `pnpm check` | All of the above in order. |
| `cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace` | Rust gates. |

## Supply chain

- `pnpm-workspace.yaml` sets `minimumReleaseAge: 10080` (7 days), `strictDepBuilds: true` and `onlyBuiltDependencies: [esbuild]`.
- Verified on 2026-11-20: requesting `vitest@5.1.1` (published 2 days earlier) is rejected; the range `^5.1.0` resolves to `5.1.0`.
- `minimumReleaseAgeExclude` is empty. Any future entry must be listed here with its reason.
- `.npmrc` sets `engine-strict=true` and `save-exact=true`.

## CI actions

Actions are pinned by commit SHA. YAML comments are rejected by `check:comments`, so the mapping lives here.

| Action | SHA | Version |
|---|---|---|
| `actions/checkout` | `3d3c42e5aac5ba805825da76410c181273ba90b1` | v7.0.1 |
| `actions/setup-node` | `949feb2413d6458794dcd2491c4babbbce0c15c1` | v7.1.0 |
| `pnpm/action-setup` | `73e46992e05b19abd31f2f3c20e0e7370d762115` | v6.1.1 |
| `actions/upload-artifact` | `cf430e030ddbb5b0abf93d22962f4752f3646cd9` | v7.0.2 |
| `actions/download-artifact` | `9000827ccba6bdab643e8b6fd33ac0654aef8333` | v8.0.2 |
| `actions/attest-build-provenance` | `4d101475d8b20a2381f78447822ac1eab6504dd8` | v4.2.2 |
| `Swatinem/rust-cache` | `d1527c8f67ef9af357290475d4af4b0fab8f12e0` | v2.9.3 |
| `dtolnay/rust-toolchain` | `39008827e6b4319a349e9a42dfc90579dd25f1ca` | `stable` branch |

## Packaging and release

| Command | Purpose |
|---|---|
| `node scripts/bundle-cli.ts [--out-dir <dir>]` | Bundle the CLI into `bma.cjs` with its esbuild metafile; version from `BMA_VERSION` or `packages/cli/package.json`. |
| `node scripts/collect-licenses.ts --meta <meta.json> --out <file> --node-license <path> [--node-version <v>]` | Write `THIRD_PARTY_LICENSES.txt` for the bundled packages and Node.js. |
| `cargo run -p bma-packager --release -- build [--out <dir>] [--node <path> \| --official-node] [--skip-smoke]` | Build and smoke-test the standalone binary. `--help` lists all options. |

- CI job `package` builds the binary on `macos-latest` and `windows-latest` and uploads it as `bma-<os>-<arch>`.
- `.github/workflows/release.yml` runs on tags `v*`: it builds with `--official-node`, archives each binary with `LICENSE` and `THIRD_PARTY_LICENSES.txt`, then a separate `publish` job writes `SHA256SUMS`, creates build provenance attestations and the GitHub release. Only `publish` has write permissions.
- `--official-node` needs `curl`, `tar` and `gpg`. On Windows, the gpg bundled with Git for Windows works through `--gpg`.

## Conventions

- No comments in code; explain behavior through names and tests.
- Fixtures named `AGENTS.md`, `CLAUDE.md`, `.claude/` or `plans/` are ignored by git and must be created in temporary directories at test time.
