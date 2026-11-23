import assert from "node:assert/strict";
import { test } from "node:test";
import { addItem, createStock, formatCsv, formatReport, removeItem, totalUnits } from "../src/inventory.js";

test("addItem adds units without mutating the stock", () => {
  const stock = createStock({ bolt: 2 });
  const next = addItem(stock, "bolt", 3);
  assert.deepEqual(next, { bolt: 5 });
  assert.deepEqual(stock, { bolt: 2 });
});

test("addItem rejects non-positive quantities", () => {
  assert.throws(() => addItem(createStock(), "bolt", 0), RangeError);
});

test("removeItem removes units", () => {
  assert.deepEqual(removeItem(createStock({ nut: 4 }), "nut", 1), { nut: 3 });
});

test("totalUnits sums all items", () => {
  assert.equal(totalUnits(createStock({ bolt: 2, nut: 3 })), 5);
});

test("formatReport lists items alphabetically with a total", () => {
  assert.equal(formatReport(createStock({ nut: 3, bolt: 2 })), "bolt: 2\nnut: 3\ntotal: 5");
});

test("formatCsv lists items alphabetically with a header", () => {
  assert.equal(formatCsv(createStock({ nut: 3, bolt: 2 })), "name,quantity\nbolt,2\nnut,3");
});
