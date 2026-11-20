import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { usageError } from "../cli-error.js";
import { passthroughProblem } from "./passthrough.js";
import { PROJECT_CONFIG_FILE, userConfigFile, type BmaDirs } from "./paths.js";
import { ConfigFileSchema, secretLikeKeys, type ConfigFile } from "./schema.js";

export interface LoadedConfigFile {
  readonly file: string;
  readonly exists: boolean;
  readonly raw: Buffer;
  readonly config: ConfigFile;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function stripBom(text: string): string {
  return text.startsWith("﻿") ? text.slice(1) : text;
}

export function parseConfigText(file: string, text: string): ConfigFile {
  let value: unknown;
  try {
    value = JSON.parse(stripBom(text));
  } catch (error) {
    throw usageError(`${file}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  const secrets = secretLikeKeys(value);
  if (secrets.length > 0) {
    throw usageError(
      `${file}: configuration must not contain credentials (${secrets.join(", ")}); provide API keys through environment variables`,
    );
  }
  const parsed = ConfigFileSchema.safeParse(value);
  if (!parsed.success) {
    throw usageError(`${file}: invalid configuration\n${z.prettifyError(parsed.error)}`);
  }
  for (const name of parsed.data.env?.passthrough ?? []) {
    const problem = passthroughProblem(name);
    if (problem !== undefined) {
      throw usageError(`${file}: env.passthrough: ${problem}`);
    }
  }
  return parsed.data;
}

export async function loadConfigFile(file: string): Promise<LoadedConfigFile> {
  let raw: Buffer;
  try {
    raw = await readFile(file);
  } catch (error) {
    if (isMissing(error)) {
      return { file, exists: false, raw: Buffer.alloc(0), config: {} };
    }
    throw usageError(`${file}: cannot be read (${error instanceof Error ? error.message : String(error)})`);
  }
  return { file, exists: true, raw, config: parseConfigText(file, raw.toString("utf8")) };
}

export function loadUserConfig(dirs: BmaDirs): Promise<LoadedConfigFile> {
  return loadConfigFile(userConfigFile(dirs));
}

export function loadProjectConfig(root: string): Promise<LoadedConfigFile> {
  return loadConfigFile(path.join(root, PROJECT_CONFIG_FILE));
}
