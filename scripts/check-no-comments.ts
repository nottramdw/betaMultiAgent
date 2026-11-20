import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanFile } from "./lib/comment-scanner.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const listing = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
  cwd: root,
  encoding: "utf8",
});
const files = listing.split("\0").filter((file) => file.length > 0 && existsSync(join(root, file)));

let violations = 0;
for (const file of files) {
  for (const finding of scanFile(file, readFileSync(join(root, file), "utf8"))) {
    violations += 1;
    process.stdout.write(`${file}:${String(finding.line)}:${String(finding.column)} ${finding.message}\n`);
  }
}

if (violations > 0) {
  process.stderr.write(`${String(violations)} violation(s) in ${String(files.length)} file(s)\n`);
  process.exitCode = 1;
}
