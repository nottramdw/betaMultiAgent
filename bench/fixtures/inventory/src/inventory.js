export function createStock(entries = {}) {
  return { ...entries };
}

export function addItem(stock, name, quantity) {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new RangeError(`quantity must be a positive integer, got ${quantity}`);
  }
  return { ...stock, [name]: (stock[name] ?? 0) + quantity };
}

export function removeItem(stock, name, quantity) {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new RangeError(`quantity must be a positive integer, got ${quantity}`);
  }
  return { ...stock, [name]: (stock[name] ?? 0) - quantity };
}

export function totalUnits(stock) {
  return Object.values(stock).reduce((sum, quantity) => sum + quantity, 0);
}

export function formatReport(stock) {
  const names = Object.keys(stock).sort((a, b) => a.localeCompare(b));
  const lines = [];
  for (const name of names) {
    lines.push(`${name}: ${stock[name]}`);
  }
  lines.push(`total: ${totalUnits(stock)}`);
  return lines.join("\n");
}

export function formatCsv(stock) {
  const names = Object.keys(stock).sort((a, b) => a.localeCompare(b));
  const lines = ["name,quantity"];
  for (const name of names) {
    lines.push(`${name},${stock[name]}`);
  }
  return lines.join("\n");
}
