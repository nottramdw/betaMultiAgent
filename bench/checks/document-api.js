import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { argv, cwd, execPath } from "node:process";
import { pathToFileURL } from "node:url";

const readme = readFileSync(path.join(cwd(), "README.md"), "utf8");
const modules = [path.join(cwd(), "src", "inventory.js"), path.join(cwd(), "src", "price.js")];
for (const file of modules) {
  const exported = Object.keys(await import(pathToFileURL(file).href));
  for (const name of exported) {
    assert.ok(readme.includes(name), `README.md does not mention ${name}`);
  }
}
const base = argv[2] ?? "HEAD";
const diff = spawnSync("git", ["diff", "--name-only", base, "--", "src", "test"], { cwd: cwd(), encoding: "utf8" });
assert.equal(diff.status, 0);
assert.equal(diff.stdout.trim(), "");
assert.equal(spawnSync(execPath, ["--test"], { cwd: cwd(), stdio: "inherit" }).status, 0);
