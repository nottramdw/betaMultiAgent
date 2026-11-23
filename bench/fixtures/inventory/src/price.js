export function applyDiscount(price, percent) {
  if (!Number.isFinite(price) || price < 0) {
    throw new RangeError(`price must be a non-negative number, got ${price}`);
  }
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new RangeError(`percent must be between 0 and 100, got ${percent}`);
  }
  return Math.round(price * (100 - percent)) / 100;
}
