import { describe, expect, it } from "vitest";
import { checkPackages, type SourceFile, type WorkspacePackage } from "../lib/dependency-rules.ts";

const CORE = "@betamultiagent/core";
const TOOLS = "@betamultiagent/tools";
const CLAUDE = "@betamultiagent/provider-claude";

function pkg(name: string, dir: string, dependencies: string[] = [], devDependencies: string[] = []): WorkspacePackage {
  return { name, dir, dependencies, devDependencies };
}

function run(packages: WorkspacePackage[], files: Record<string, SourceFile[]>, rootDev: string[] = ["vitest"]): string[] {
  return checkPackages(packages, rootDev, new Map(Object.entries(files))).map((violation) => `${violation.file} ${violation.message}`);
}

describe("dependency rules", () => {
  it("accepts allowed internal edges and declared imports", () => {
    const result = run([pkg(CORE, "packages/core", ["zod"]), pkg(TOOLS, "packages/tools", [CORE])], {
      [CORE]: [{ path: "packages/core/src/index.ts", text: 'import { z } from "zod";\nimport { join } from "node:path";\nexport * from "./a.js";' }],
      [TOOLS]: [
        { path: "packages/tools/src/index.ts", text: 'import type { Environment } from "@betamultiagent/core";' },
        { path: "packages/tools/test/a.test.ts", text: 'import { it } from "vitest";' },
      ],
    });
    expect(result).toEqual([]);
  });

  it("rejects edges outside the graph in manifests and imports", () => {
    const result = run([pkg(CORE, "packages/core", [TOOLS]), pkg(TOOLS, "packages/tools", [CORE])], {
      [CORE]: [{ path: "packages/core/src/index.ts", text: `import "${TOOLS}";` }],
    });
    expect(result).toEqual([
      `packages/core/package.json ${CORE} must not depend on ${TOOLS}`,
      `packages/core/src/index.ts ${CORE} must not depend on ${TOOLS}`,
    ]);
  });

  it("reserves provider SDKs for their adapter package", () => {
    const result = run([pkg(CORE, "packages/core", ["@xai-official/sdk"]), pkg(CLAUDE, "packages/providers/claude", [CORE, "@anthropic-ai/sdk"])], {
      [CLAUDE]: [{ path: "packages/providers/claude/src/index.ts", text: 'import Anthropic from "@anthropic-ai/sdk";' }],
    });
    expect(result).toEqual(["packages/core/package.json @xai-official/sdk is reserved for @betamultiagent/provider-grok"]);
  });

  it("requires source imports to be production dependencies", () => {
    const result = run([pkg(CORE, "packages/core", [], ["yaml"])], {
      [CORE]: [
        { path: "packages/core/src/a.ts", text: 'import { parse } from "yaml";\nimport { it } from "vitest";' },
        { path: "packages/core/test/a.test.ts", text: 'import { parse } from "yaml";' },
      ],
    });
    expect(result).toEqual([
      "packages/core/src/a.ts yaml is not declared in packages/core/package.json",
      "packages/core/src/a.ts vitest is not declared in packages/core/package.json",
    ]);
  });

  it("rejects relative imports that leave the package, unprefixed builtins and dynamic imports of undeclared packages", () => {
    const result = run([pkg(CORE, "packages/core")], {
      [CORE]: [{ path: "packages/core/src/a.ts", text: 'import "../../tools/src/index.js";\nimport "fs";\nawait import("left-pad");' }],
    });
    expect(result).toEqual([
      "packages/core/src/a.ts relative import ../../tools/src/index.js leaves packages/core",
      "packages/core/src/a.ts builtin fs must use the node: prefix",
      "packages/core/src/a.ts left-pad is not declared in packages/core/package.json",
    ]);
  });

  it("resolves scoped subpath imports to the package name", () => {
    const result = run([pkg(CLAUDE, "packages/providers/claude", [CORE])], {
      [CLAUDE]: [{ path: "packages/providers/claude/test/a.test.ts", text: 'import { ScriptedProvider } from "@betamultiagent/core/testing";' }],
    });
    expect(result).toEqual([]);
  });

  it("rejects unknown workspace packages", () => {
    expect(run([pkg("@betamultiagent/extra", "packages/extra")], {})).toEqual([
      "packages/extra/package.json unknown workspace package @betamultiagent/extra",
    ]);
  });
});
