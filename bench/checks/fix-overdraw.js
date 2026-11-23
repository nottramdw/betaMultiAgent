import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { cwd, execPath } from "node:process";
import { pathToFileURL } from "node:url";

const { removeItem } = await import(pathToFileURL(path.join(cwd(), "src", "inventory.js")).href);

assert.throws(() => removeItem({ nut: 2 }, "nut", 3), RangeError);
assert.throws(() => removeItem({}, "bolt", 1), RangeError);
const stock = { nut: 2 };
const drained = removeItem(stock, "nut", 2);
assert.ok(drained.nut === 0 || !("nut" in drained));
assert.deepEqual(stock, { nut: 2 });
assert.deepEqual(removeItem({ nut: 4 }, "nut", 1), { nut: 3 });
assert.equal(spawnSync(execPath, ["--test"], { cwd: cwd(), stdio: "inherit" }).status, 0);
