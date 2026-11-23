import assert from "node:assert/strict";
import { test } from "node:test";
import { applyDiscount } from "../src/price.js";

test("applyDiscount reduces the price and rounds to cents", () => {
  assert.equal(applyDiscount(19.99, 15), 16.99);
  assert.equal(applyDiscount(10, 0), 10);
  assert.equal(applyDiscount(10, 100), 0);
});

test("applyDiscount rejects percentages above 100", () => {
  assert.throws(() => applyDiscount(10, 101), RangeError);
});
