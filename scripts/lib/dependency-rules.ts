import { builtinModules } from "node:module";
import { posix } from "node:path";
import ts from "typescript";

export interface WorkspacePackage {
  readonly name: string;
  readonly dir: string;
  readonly dependencies: readonly string[];
  readonly devDependencies: readonly string[];
}

export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

export interface Violation {
  readonly file: string;
  readonly message: string;
}

const CORE = "@betamultiagent/core";

export const ALLOWED_INTERNAL: ReadonlyMap<string, readonly string[]> = new Map([
  [CORE, []],
  ["@betamultiagent/provider-claude", [CORE]],
  ["@betamultiagent/provider-grok", [CORE]],
  ["@betamultiagent/tools", [CORE]],
  ["@betamultiagent/skills", [CORE]],
  [
    "@betamultiagent/cli",
    [
      CORE,
      "@betamultiagent/provider-claude",
      "@betamultiagent/provider-grok",
      "@betamultiagent/tools",
      "@betamultiagent/skills",
    ],
  ],
]);

export const EXCLUSIVE_DEPENDENCIES: ReadonlyMap<string, string> = new Map([
  ["@anthropic-ai/sdk", "@betamultiagent/provider-claude"],
  ["@xai-official/sdk", "@betamultiagent/provider-grok"],
]);

const BUILTINS: ReadonlySet<string> = new Set(builtinModules);

export function checkPackages(
  packages: readonly WorkspacePackage[],
  rootDevDependencies: readonly string[],
  filesByPackage: ReadonlyMap<string, readonly SourceFile[]>,
): Violation[] {
  const violations: Violation[] = [];
  const internalNames = new Set(packages.map((pkg) => pkg.name));
  for (const pkg of packages) {
    const manifest = posix.join(pkg.dir, "package.json");
    const allowed = ALLOWED_INTERNAL.get(pkg.name);
    if (allowed === undefined) {
      violations.push({ file: manifest, message: `unknown workspace package ${pkg.name}` });
      continue;
    }
    for (const dependency of [...pkg.dependencies, ...pkg.devDependencies]) {
      violations.push(...checkEdge(manifest, pkg.name, dependency, allowed, internalNames));
    }
    for (const file of filesByPackage.get(pkg.name) ?? []) {
      const isTest = !file.path.startsWith(`${pkg.dir}/src/`);
      const declared = new Set(isTest ? [...pkg.dependencies, ...pkg.devDependencies, ...rootDevDependencies] : pkg.dependencies);
      for (const specifier of importSpecifiers(file)) {
        violations.push(...checkImport(file.path, pkg, specifier, declared, allowed, internalNames));
      }
    }
  }
  return violations;
}

function checkEdge(
  file: string,
  owner: string,
  dependency: string,
  allowed: readonly string[],
  internalNames: ReadonlySet<string>,
): Violation[] {
  if (internalNames.has(dependency) && !allowed.includes(dependency)) {
    return [{ file, message: `${owner} must not depend on ${dependency}` }];
  }
  const exclusiveOwner = EXCLUSIVE_DEPENDENCIES.get(dependency);
  if (exclusiveOwner !== undefined && exclusiveOwner !== owner) {
    return [{ file, message: `${dependency} is reserved for ${exclusiveOwner}` }];
  }
  return [];
}

function checkImport(
  file: string,
  pkg: WorkspacePackage,
  specifier: string,
  declared: ReadonlySet<string>,
  allowed: readonly string[],
  internalNames: ReadonlySet<string>,
): Violation[] {
  if (specifier.startsWith("node:")) {
    return [];
  }
  if (specifier.startsWith(".")) {
    const target = posix.normalize(posix.join(posix.dirname(file), specifier));
    return target.startsWith(`${pkg.dir}/`) ? [] : [{ file, message: `relative import ${specifier} leaves ${pkg.dir}` }];
  }
  if (specifier.startsWith("/") || /^[A-Za-z]:/u.test(specifier)) {
    return [{ file, message: `absolute import ${specifier}` }];
  }
  const name = packageName(specifier);
  if (BUILTINS.has(name)) {
    return [{ file, message: `builtin ${specifier} must use the node: prefix` }];
  }
  const edge = checkEdge(file, pkg.name, name, allowed, internalNames);
  if (edge.length > 0) {
    return edge;
  }
  return declared.has(name) ? [] : [{ file, message: `${name} is not declared in ${pkg.dir}/package.json` }];
}

function packageName(specifier: string): string {
  const segments = specifier.split("/");
  const count = specifier.startsWith("@") ? 2 : 1;
  return segments.slice(0, count).join("/");
}

function importSpecifiers(file: SourceFile): string[] {
  return ts.preProcessFile(file.text, true, true).importedFiles.map((reference) => reference.fileName);
}
