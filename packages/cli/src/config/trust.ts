import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { usageError } from "../cli-error.js";
import { trustFile, type BmaDirs } from "./paths.js";

const TrustEntrySchema = z.object({ configSha256: z.string().regex(/^[0-9a-f]{64}$/u), trustedAt: z.string() });

const TrustFileSchema = z.object({
  version: z.literal(1),
  workspaces: z.record(z.string(), TrustEntrySchema),
});
type TrustData = z.infer<typeof TrustFileSchema>;

export function configDigest(raw: Buffer): string {
  return createHash("sha256").update(raw).digest("hex");
}

async function readTrust(dirs: BmaDirs): Promise<TrustData> {
  const file = trustFile(dirs);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, workspaces: {} };
    }
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  const parsed = TrustFileSchema.safeParse(value);
  if (!parsed.success) {
    throw usageError(`${file} is corrupt; delete it and run bma trust again`);
  }
  return parsed.data;
}

async function writeTrust(dirs: BmaDirs, data: TrustData): Promise<void> {
  const file = trustFile(dirs);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export async function isTrusted(dirs: BmaDirs, root: string, digest: string): Promise<boolean> {
  const entry = (await readTrust(dirs)).workspaces[root];
  return entry?.configSha256 === digest;
}

export async function grantTrust(dirs: BmaDirs, root: string, digest: string, now: Date): Promise<void> {
  const data = await readTrust(dirs);
  await writeTrust(dirs, {
    version: 1,
    workspaces: { ...data.workspaces, [root]: { configSha256: digest, trustedAt: now.toISOString() } },
  });
}

export async function revokeTrust(dirs: BmaDirs, root: string): Promise<boolean> {
  const data = await readTrust(dirs);
  if (data.workspaces[root] === undefined) {
    return false;
  }
  const workspaces = Object.fromEntries(Object.entries(data.workspaces).filter(([key]) => key !== root));
  await writeTrust(dirs, { version: 1, workspaces });
  return true;
}
