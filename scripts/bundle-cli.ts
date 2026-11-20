import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

interface Manifest {
  readonly version: string;
}

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { "out-dir": { type: "string" } }, strict: true });
const outDir = resolve(values["out-dir"] ?? join(root, "target", "sea"));
const manifest = JSON.parse(readFileSync(join(root, "packages", "cli", "package.json"), "utf8")) as Manifest;
const version = process.env["BMA_VERSION"] ?? manifest.version;

mkdirSync(outDir, { recursive: true });
const result = await build({
  stdin: {
    contents: 'import { runCli } from "./main.ts";\nvoid runCli();\n',
    resolveDir: join(root, "packages", "cli", "src"),
    sourcefile: "sea-entry.ts",
    loader: "ts",
  },
  absWorkingDir: root,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  conditions: ["source"],
  define: { __BMA_VERSION__: JSON.stringify(version) },
  legalComments: "external",
  metafile: true,
  outfile: join(outDir, "bma.cjs"),
  logLevel: "warning",
});
writeFileSync(join(outDir, "meta.json"), JSON.stringify(result.metafile));
writeFileSync(join(outDir, "version.txt"), version);
process.stdout.write(`${join(outDir, "bma.cjs")}\n`);
