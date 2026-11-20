import { randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LENGTH = 10;
const RANDOM_LENGTH = 16;
const MAX_TIME = 2 ** 48 - 1;

export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/u;

function encodeTime(time: number): string {
  let remaining = time;
  let out = "";
  for (let index = 0; index < TIME_LENGTH; index += 1) {
    out = (CROCKFORD[remaining % 32] ?? "0") + out;
    remaining = Math.floor(remaining / 32);
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < RANDOM_LENGTH) {
      bits -= 5;
      out += CROCKFORD[(value >> bits) & 31] ?? "0";
    }
    value &= (1 << bits) - 1;
  }
  return out;
}

export function ulid(time: number = Date.now(), random: (size: number) => Uint8Array = randomBytes): string {
  if (!Number.isInteger(time) || time < 0 || time > MAX_TIME) {
    throw new RangeError(`ulid time out of range: ${String(time)}`);
  }
  return encodeTime(time) + encodeRandom(random(10));
}

export function ulidTime(id: string): number {
  if (!ULID_PATTERN.test(id)) {
    throw new TypeError(`not a ULID: ${id}`);
  }
  let time = 0;
  for (const char of id.slice(0, TIME_LENGTH)) {
    time = time * 32 + CROCKFORD.indexOf(char);
  }
  return time;
}
