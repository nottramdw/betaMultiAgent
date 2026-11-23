import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { cwd, execPath } from "node:process";
import { pathToFileURL } from "node:url";

const { lowStock } = await import(pathToFileURL(path.join(cwd(), "src", "inventory.js")).href);

assert.equal(typeof lowStock, "function");
assert.deepEqual(lowStock({ washer: 1, bolt: 5, nut: 0, axle: 2 }, 2), ["nut", "washer"]);
assert.deepEqual(lowStock({ bolt: 2 }, 2), []);
assert.deepEqual(lowStock({}, 10), []);
assert.equal(spawnSync(execPath, ["--test"], { cwd: cwd(), stdio: "inherit" }).status, 0);
