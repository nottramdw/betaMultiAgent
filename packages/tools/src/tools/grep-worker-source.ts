export const GREP_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const { pattern, flags, files, maxResults, maxLineChars, maxFileBytes, probeBytes } = workerData;
const regex = new RegExp(pattern, flags);
const matches = [];
let skippedBinary = 0;
let skippedLarge = 0;
let truncated = false;
outer: for (const file of files) {
  let buffer;
  try {
    const stat = fs.statSync(file.absolute);
    if (!stat.isFile()) {
      continue;
    }
    if (stat.size > maxFileBytes) {
      skippedLarge += 1;
      continue;
    }
    buffer = fs.readFileSync(file.absolute);
  } catch (error) {
    continue;
  }
  if (buffer.subarray(0, probeBytes).includes(0)) {
    skippedBinary += 1;
    continue;
  }
  const lines = buffer.toString("utf8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (regex.test(line)) {
      if (matches.length >= maxResults) {
        truncated = true;
        break outer;
      }
      const text = line.length > maxLineChars ? line.slice(0, maxLineChars) + "..." : line;
      matches.push({ file: file.display, line: index + 1, text });
    }
  }
}
parentPort.postMessage({ matches, skippedBinary, skippedLarge, truncated });
`;
