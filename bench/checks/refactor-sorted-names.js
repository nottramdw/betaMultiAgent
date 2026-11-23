import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { cwd, execPath } from "node:process";
import { pathToFileURL } from "node:url";

const file = path.join(cwd(), "src", "inventory.js");
const { formatCsv, formatReport } = await import(pathToFileURL(file).href);

const stock = { nut: 3, Bolt: 2, axle: 0, "élan": 1 };
assert.equal(formatReport(stock), "axle: 0\nBolt: 2\nélan: 1\nnut: 3\ntotal: 6");
assert.equal(formatCsv(stock), "name,quantity\naxle,0\nBolt,2\nélan,1\nnut,3");
assert.equal(formatReport({}), "total: 0");
assert.equal(formatCsv({}), "name,quantity");
assert.equal(readFileSync(file, "utf8").split("localeCompare").length - 1, 1);
assert.equal(spawnSync(execPath, ["--test"], { cwd: cwd(), stdio: "inherit" }).status, 0);
