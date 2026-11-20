import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { realpathSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { bundledPackageDirs, isAllowedLicense, LicenseError, readBundledPackages, renderThirdPartyLicenses } from "../lib/license-collector.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function workspace(files: Record<string, string>): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "bma-licenses-")));
  dirs.push(root);
  for (const [name, text] of Object.entries(files)) {
    const file = join(root, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return root;
}

const SDK = "node_modules/.pnpm/sdk@1.0.0/node_modules/@acme/sdk";

describe("isAllowedLicense", () => {
  it("accepts allowlisted identifiers and permissive expressions", () => {
    expect(isAllowedLicense("MIT")).toBe(true);
    expect(isAllowedLicense("(MIT OR GPL-3.0)")).toBe(true);
    expect(isAllowedLicense("MIT AND GPL-3.0")).toBe(false);
    expect(isAllowedLicense("GPL-3.0")).toBe(false);
    expect(isAllowedLicense("")).toBe(false);
  });
});

describe("license collection", () => {
  it("collects LICENSE and NOTICE files of bundled packages only", () => {
    const root = workspace({
      [`${SDK}/package.json`]: JSON.stringify({ name: "@acme/sdk", version: "1.0.0", license: "Apache-2.0" }),
      [`${SDK}/LICENSE`]: "Apache License text",
      [`${SDK}/NOTICE`]: "Acme notice",
      [`${SDK}/dist/index.mjs`]: "",
      "node_modules/.pnpm/unused@1.0.0/node_modules/unused/package.json": JSON.stringify({ name: "unused", license: "GPL-3.0" }),
      "packages/cli/src/main.ts": "",
    });
    const found = bundledPackageDirs({ inputs: { [`${SDK}/dist/index.mjs`]: {}, "packages/cli/src/main.ts": {} } }, root);
    expect(found).toHaveLength(1);
    const packages = readBundledPackages(found, root);
    const text = renderThirdPartyLicenses({ name: "LICENSE", text: "MIT project" }, packages, { version: "v22.23.4", text: "Node.js license" });
    expect(text).toContain("@acme/sdk@1.0.0 (Apache-2.0)");
    expect(text).toContain("Acme notice");
    expect(text).toContain("Node.js v22.23.4");
    expect(text).toContain("Node.js license");
    expect(text).not.toContain("unused");
  });

  it("uses a license pinned for the exact package version when the package ships none", () => {
    const root = workspace({
      "node_modules/@acme/hooks/package.json": JSON.stringify({ name: "@acme/hooks", version: "1.1.1", license: "MIT" }),
      "pins/@acme+hooks@1.1.1/LICENSE": "MIT upstream",
      "pins/@acme+hooks@1.0.0/LICENSE": "older",
    });
    const [entry] = readBundledPackages([join(root, "node_modules", "@acme", "hooks")], root, join(root, "pins"));
    expect(entry?.files).toEqual([{ name: "LICENSE (pinned from the upstream repository; not shipped in the package)", text: "MIT upstream" }]);
  });

  it("fails on a missing license file or a license outside the allowlist", () => {
    const root = workspace({
      "node_modules/bare/package.json": JSON.stringify({ name: "bare", version: "1.0.0", license: "MIT" }),
      "node_modules/copyleft/package.json": JSON.stringify({ name: "copyleft", version: "2.0.0", license: "GPL-3.0" }),
      "node_modules/copyleft/LICENSE": "GPL",
    });
    const run = (): unknown => readBundledPackages([join(root, "node_modules", "bare"), join(root, "node_modules", "copyleft")], root);
    expect(run).toThrow(LicenseError);
    try {
      run();
    } catch (error) {
      expect((error as LicenseError).problems).toEqual(["bare@1.0.0: no LICENSE file", "copyleft@2.0.0: license GPL-3.0 is not in the allowlist"]);
    }
  });
});
