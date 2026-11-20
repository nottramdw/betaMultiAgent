import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export const LICENSE_ALLOWLIST: ReadonlySet<string> = new Set(["MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "Unlicense"]);

const LEGAL_FILE = /^(?:licen[cs]e|notice|copying)(?:[.-].*)?$/iu;
const NODE_MODULES = `node_modules${sep}`;

export interface Metafile {
  readonly inputs: Readonly<Record<string, unknown>>;
}

export interface LegalFile {
  readonly name: string;
  readonly text: string;
}

export interface BundledPackage {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly dir: string;
  readonly files: readonly LegalFile[];
}

export interface NodeLicense {
  readonly version: string;
  readonly text: string;
}

export class LicenseError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`third-party license check failed:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    this.name = "LicenseError";
    this.problems = problems;
  }
}

function packageDirOf(file: string): string | undefined {
  const index = file.lastIndexOf(NODE_MODULES);
  if (index < 0) {
    return undefined;
  }
  const start = index + NODE_MODULES.length;
  const parts = file.slice(start).split(sep);
  const [first, second] = parts;
  if (first === undefined) {
    return undefined;
  }
  const name = first.startsWith("@") && second !== undefined ? `${first}${sep}${second}` : first;
  return file.slice(0, start) + name;
}

export function bundledPackageDirs(metafile: Metafile, workingDir: string): string[] {
  const dirs = new Set<string>();
  for (const input of Object.keys(metafile.inputs)) {
    const dir = packageDirOf(resolve(workingDir, input));
    if (dir !== undefined) {
      dirs.add(realpathSync.native(dir));
    }
  }
  return [...dirs].sort();
}

export function isAllowedLicense(expression: string): boolean {
  const trimmed = expression.trim().replace(/^\((.*)\)$/u, "$1");
  if (/ AND /u.test(trimmed)) {
    return trimmed.split(" AND ").every((part) => isAllowedLicense(part));
  }
  return trimmed.split(" OR ").some((part) => LICENSE_ALLOWLIST.has(part.trim()));
}

function legalFiles(dir: string): LegalFile[] {
  return readdirSync(dir)
    .filter((name) => LEGAL_FILE.test(name) && statSync(join(dir, name)).isFile())
    .sort()
    .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8").replace(/\r\n/gu, "\n").trimEnd() }));
}

interface PackageManifest {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly license?: unknown;
}

export function pinnedLicenseDir(overridesDir: string, name: string, version: string): string {
  return join(overridesDir, `${name.replace("/", "+")}@${version}`);
}

function pinnedFiles(overridesDir: string | undefined, name: string, version: string): LegalFile[] {
  if (overridesDir === undefined) {
    return [];
  }
  const dir = pinnedLicenseDir(overridesDir, name, version);
  try {
    return legalFiles(dir).map((file) => ({ name: `${file.name} (pinned from the upstream repository; not shipped in the package)`, text: file.text }));
  } catch {
    return [];
  }
}

export function readBundledPackages(dirs: readonly string[], workingDir: string, overridesDir?: string): BundledPackage[] {
  const problems: string[] = [];
  const packages: BundledPackage[] = [];
  for (const dir of dirs) {
    const label = relative(workingDir, dir) || dir;
    let manifest: PackageManifest;
    try {
      manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as PackageManifest;
    } catch {
      problems.push(`${label}: package.json cannot be read`);
      continue;
    }
    const name = typeof manifest.name === "string" ? manifest.name : label;
    const version = typeof manifest.version === "string" ? manifest.version : "unknown";
    const license = typeof manifest.license === "string" ? manifest.license : "";
    if (!isAllowedLicense(license)) {
      problems.push(`${name}@${version}: license ${license === "" ? "(missing)" : license} is not in the allowlist`);
    }
    const shipped = legalFiles(dir);
    const files = shipped.some((file) => /^licen[cs]e|^copying/iu.test(file.name)) ? shipped : [...shipped, ...pinnedFiles(overridesDir, name, version)];
    if (!files.some((file) => /^licen[cs]e|^copying/iu.test(file.name))) {
      problems.push(`${name}@${version}: no LICENSE file`);
    }
    packages.push({ name, version, license, dir, files });
  }
  if (problems.length > 0) {
    throw new LicenseError(problems);
  }
  return packages.sort((a, b) => a.name.localeCompare(b.name));
}

const RULE = "=".repeat(78);

export function renderThirdPartyLicenses(project: LegalFile, packages: readonly BundledPackage[], node: NodeLicense): string {
  const sections = [
    `betaMultiAgent\n${RULE}\n${project.text}`,
    `Node.js ${node.version} (runtime embedded in this executable)\n${RULE}\n${node.text.replace(/\r\n/gu, "\n").trimEnd()}`,
    ...packages.map(
      (entry) =>
        `${entry.name}@${entry.version} (${entry.license})\n${RULE}\n${entry.files.map((file) => `--- ${file.name} ---\n${file.text}`).join("\n\n")}`,
    ),
  ];
  return `${sections.join("\n\n\n")}\n`;
}
