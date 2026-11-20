# Third-Party Notices

This project is not affiliated with or endorsed by xAI or Anthropic.

## Development dependencies

Used to build and test the project; not distributed in release binaries.

| Package | Version | License |
|---|---|---|
| typescript | 6.0.3 | Apache-2.0 |
| eslint | 10.14.0 | MIT |
| @eslint/js | 10.0.1 | MIT |
| typescript-eslint | 8.72.2 | MIT |
| vitest | 5.1.0 | MIT |
| vite | 8.3.8 | MIT |
| @types/node | 22.20.5 | MIT |
| @types/picomatch | 4.0.3 | MIT |
| esbuild | 0.28.2 | MIT |
| postject | 1.0.0-alpha.6 | MIT |

## Runtime dependencies

| Package | Version | License |
|---|---|---|
| @anthropic-ai/sdk | 1.8.0 | Apache-2.0 |
| @xai-official/sdk | 0.2.8 | Apache-2.0 |
| @opentelemetry/api | 1.10.0 | Apache-2.0 |
| zod | 4.6.7 | MIT |
| picomatch | 4.0.7 | MIT |
| yaml | 2.9.1 | ISC |
| json-schema-to-ts | 3.1.1 | MIT |
| ts-algebra | 2.0.0 | MIT |
| @babel/runtime | 7.29.14 | MIT |
| standardwebhooks | 1.1.1 | MIT |
| @stablelib/base64 | 1.0.1 | MIT |
| fast-sha256 | 1.3.0 | Unlicense |

`json-schema-to-ts`, `ts-algebra` and `@babel/runtime` are type-level dependencies of `@anthropic-ai/sdk` and are not present in the bundled CLI.

## Release binaries

Release binaries embed Node.js and ship a generated `THIRD_PARTY_LICENSES.txt` with the full license and notice texts of Node.js and of every package that the bundler actually included, as recorded in the esbuild metafile ([scripts/collect-licenses.ts](scripts/collect-licenses.ts)). Packages outside the allowlist MIT, ISC, Apache-2.0, BSD-2-Clause, BSD-3-Clause, 0BSD and Unlicense, or without a license file, fail the build.

`standardwebhooks` 1.1.1 is published without a license file. Its MIT license text is pinned from the upstream repository in [scripts/licenses/standardwebhooks@1.1.1/LICENSE](scripts/licenses/standardwebhooks@1.1.1/LICENSE) and labelled as such in the generated file.

The Node.js release signing keys in [scripts/keys/node-release-keys.asc](scripts/keys/node-release-keys.asc) are the public keys listed in `keys.list` of [nodejs/release-keys](https://github.com/nodejs/release-keys) at commit `481637f813e912c4aa3622d7964ab426c97b8e8d`.

## Ported code

None. The repositories of the xAI GitHub organization were studied for design ideas only; no code from them is copied into this project. `@xai-official/sdk` is used unmodified as an npm dependency. Code adapted from other repositories in the future will be listed here with its source, commit, license and the files it appears in.
