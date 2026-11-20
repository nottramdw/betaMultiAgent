import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { bundledPackageDirs, LicenseError, readBundledPackages, renderThirdPartyLicenses, type Metafile } from "./lib/license-collector.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({
  options: {
    meta: { type: "string" },
    out: { type: "string" },
    "node-license": { type: "string" },
    "node-version": { type: "string" },
  },
  strict: true,
});

const meta = values.meta;
const out = values.out;
const nodeLicense = values["node-license"];
if (meta === undefined || out === undefined || nodeLicense === undefined) {
  process.stderr.write("usage: collect-licenses --meta <metafile> --out <file> --node-license <path> [--node-version <v>]\n");
  process.exit(2);
}

try {
  const metafile = JSON.parse(readFileSync(resolve(meta), "utf8")) as Metafile;
  const packages = readBundledPackages(bundledPackageDirs(metafile, root), root, join(root, "scripts", "licenses"));
  const text = renderThirdPartyLicenses(
    { name: "LICENSE", text: readFileSync(join(root, "LICENSE"), "utf8").replace(/\r\n/gu, "\n").trimEnd() },
    packages,
    { version: values["node-version"] ?? process.version, text: readFileSync(resolve(nodeLicense), "utf8") },
  );
  writeFileSync(resolve(out), text);
  process.stdout.write(`${String(packages.length)} third-party packages\n`);
} catch (error) {
  process.stderr.write(`${error instanceof LicenseError ? error.message : String(error)}\n`);
  process.exit(1);
}
