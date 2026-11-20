import { readFile } from "node:fs/promises";
import { usageError } from "../cli-error.js";

function swapBytes(bytes: Uint8Array): Uint8Array {
  const swapped = new Uint8Array(bytes.length - (bytes.length % 2));
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    swapped[index] = bytes[index + 1] ?? 0;
    swapped[index + 1] = bytes[index] ?? 0;
  }
  return swapped;
}

export function decodePromptBytes(bytes: Uint8Array, label: string): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return decodeUtf8(bytes.subarray(3), label);
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16le").decode(swapBytes(bytes.subarray(2)));
  }
  return decodeUtf8(bytes, label);
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw usageError(
      `${label} is not valid UTF-8; save it as UTF-8 (in Windows PowerShell 5.1: Out-File -Encoding utf8) or as UTF-16 with a byte order mark`,
    );
  }
}

export async function readPromptFile(file: string): Promise<string> {
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (error) {
    throw usageError(`cannot read prompt file ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return decodePromptBytes(bytes, file);
}

export async function readStream(input: NodeJS.ReadableStream, label: string): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk));
  }
  return decodePromptBytes(Buffer.concat(chunks), label);
}
