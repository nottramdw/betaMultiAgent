import path from "node:path";

export function isInsideOrEqual(base: string, target: string, caseSensitive: boolean, pathApi: path.PlatformPath = path): boolean {
  const fold = (value: string): string => (caseSensitive ? value : value.toLowerCase());
  const relative = pathApi.relative(fold(base), fold(target));
  if (relative === "") {
    return true;
  }
  return relative !== ".." && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative);
}

export function samePath(left: string, right: string, caseSensitive: boolean): boolean {
  return caseSensitive ? left === right : left.toLowerCase() === right.toLowerCase();
}

export function stripExtendedPrefix(value: string): string {
  return /^\\\\\?\\[A-Za-z]:\\/u.test(value) ? value.slice(4) : value;
}
