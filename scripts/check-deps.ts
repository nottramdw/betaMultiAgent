import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPackages, type SourceFile, type WorkspacePackage } from "./lib/dependency-rules.ts";

interface Manifest {
  readonly name?: unknown;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

const root = fileURLToPath(new URL("..", import.meta.url));
const PACKAGE_PARENTS = ["packages", "packages/providers"];
const SOURCE_DIRS = ["src", "test"];
const SKIPPED_DIRS: ReadonlySet<string> = new Set(["node_modules", "dist"]);

function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")) as Manifest;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function hasManifest(dir: string): boolean {
  try {
    return statSync(join(root, dir, "package.json")).isFile();
  } catch {
    return false;
  }
}

function listPackageDirs(): string[] {
  return PACKAGE_PARENTS.flatMap((parent) =>
    readdirSync(join(root, parent), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => posix.join(parent, entry.name))
      .filter(hasManifest),
  ).sort();
}

function listSources(dir: string): SourceFile[] {
  const absolute = join(root, dir);
  if (!isDirectory(absolute)) {
    return [];
  }
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const path = posix.join(dir, entry.name);
    if (entry.isDirectory()) {
      return SKIPPED_DIRS.has(entry.name) ? [] : listSources(path);
    }
    return /\.[cm]?ts$/u.test(entry.name) ? [{ path, text: readFileSync(join(root, path), "utf8") }] : [];
  });
}

const packages: WorkspacePackage[] = [];
const filesByPackage = new Map<string, SourceFile[]>();
for (const dir of listPackageDirs()) {
  const manifest = readManifest(dir);
  const name = typeof manifest.name === "string" ? manifest.name : dir;
  packages.push({
    name,
    dir,
    dependencies: Object.keys(manifest.dependencies ?? {}),
    devDependencies: Object.keys(manifest.devDependencies ?? {}),
  });
  filesByPackage.set(
    name,
    SOURCE_DIRS.flatMap((sourceDir) => listSources(posix.join(dir, sourceDir))),
  );
}

const rootDevDependencies = Object.keys(readManifest(".").devDependencies ?? {});
const violations = checkPackages(packages, rootDevDependencies, filesByPackage);
for (const violation of violations) {
  process.stdout.write(`${violation.file} ${violation.message}\n`);
}
if (violations.length > 0) {
  process.stderr.write(`${String(violations.length)} dependency violation(s)\n`);
  process.exitCode = 1;
}
