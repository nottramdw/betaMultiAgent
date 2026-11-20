import { chmodSync, linkSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PathEscapeError } from "@betamultiagent/core";
import { describe, expect, it } from "vitest";
import { createLocalEnvironment, type LocalEnvironmentOptions } from "../src/index.js";
import { ExecError } from "../src/process/exec-error.js";
import { hasCommand, makeTempDir, registerCleanup, writeTree } from "./helpers.js";

registerCleanup();

const isWindows = process.platform === "win32";

function newEnvironment(files: Record<string, string> = {}, extra: Partial<Omit<LocalEnvironmentOptions, "root">> = {}) {
  const root = makeTempDir();
  writeTree(root, { "src/a.txt": "a", ...files });
  return { root, environment: createLocalEnvironment({ root, ...extra }) };
}

describe("resolvePath", () => {
  it("resolves relative and absolute paths inside the root", async () => {
    const { root, environment } = newEnvironment();
    const relative = await environment.resolvePath("src/a.txt", "read");
    expect(relative.real).toBe(path.join(root, "src", "a.txt"));
    const absolute = await environment.resolvePath(path.join(root, "src", "a.txt"), "read");
    expect(absolute.real).toBe(relative.real);
  });

  it("allows a not-yet-existing file in an existing directory", async () => {
    const { root, environment } = newEnvironment();
    const resolved = await environment.resolvePath("src/new.txt", "write");
    expect(resolved.real).toBe(path.join(root, "src", "new.txt"));
  });

  it.each(["../outside.txt", "src/../../outside.txt", "..", ""])("rejects %j", async (input) => {
    const { environment } = newEnvironment();
    await expect(environment.resolvePath(input, "read")).rejects.toBeInstanceOf(PathEscapeError);
  });

  it("rejects an absolute path outside the root", async () => {
    const { environment } = newEnvironment();
    const outside = makeTempDir();
    await expect(environment.resolvePath(path.join(outside, "x"), "read")).rejects.toBeInstanceOf(PathEscapeError);
  });

  it("allows read access to extra read roots but not write access", async () => {
    const extra = makeTempDir();
    writeTree(extra, { "lib.txt": "x" });
    const { environment } = newEnvironment({}, { extraReadRoots: [extra] });
    await expect(environment.resolvePath(path.join(extra, "lib.txt"), "read")).resolves.toBeDefined();
    await expect(environment.resolvePath(path.join(extra, "lib.txt"), "write")).rejects.toBeInstanceOf(PathEscapeError);
  });

  it("rejects a symlink pointing outside the root", async () => {
    const { root, environment } = newEnvironment();
    const outside = makeTempDir();
    writeTree(outside, { "secret.txt": "s" });
    try {
      symlinkSync(outside, path.join(root, "link"), isWindows ? "junction" : "dir");
    } catch {
      return;
    }
    await expect(environment.resolvePath("link/secret.txt", "read")).rejects.toBeInstanceOf(PathEscapeError);
    await expect(environment.resolvePath("link/new.txt", "write")).rejects.toBeInstanceOf(PathEscapeError);
  });

  it("rejects a dangling symlink whose target is outside the root", async () => {
    const { root, environment } = newEnvironment();
    const outside = makeTempDir();
    try {
      symlinkSync(path.join(outside, "missing.txt"), path.join(root, "dangling"), "file");
    } catch {
      return;
    }
    await expect(environment.resolvePath("dangling", "write")).rejects.toBeInstanceOf(PathEscapeError);
  });

  it("exposes the real path of a symlink that stays inside the root", async () => {
    const { root, environment } = newEnvironment();
    try {
      symlinkSync(path.join(root, "src", "a.txt"), path.join(root, "alias.txt"), "file");
    } catch {
      return;
    }
    const resolved = await environment.resolvePath("alias.txt", "read");
    expect(resolved.real).toBe(path.join(root, "src", "a.txt"));
    expect(resolved.requested).not.toBe(resolved.real);
  });

  it("refuses to write through a symlink target", async () => {
    const { root, environment } = newEnvironment();
    try {
      symlinkSync(path.join(root, "src", "a.txt"), path.join(root, "alias.txt"), "file");
    } catch {
      return;
    }
    await expect(environment.resolvePath("alias.txt", "write")).rejects.toBeInstanceOf(PathEscapeError);
  });

  it("refuses to write to a file with several hard links", async () => {
    const { root, environment } = newEnvironment();
    linkSync(path.join(root, "src", "a.txt"), path.join(root, "hard.txt"));
    await expect(environment.resolvePath("hard.txt", "write")).rejects.toBeInstanceOf(PathEscapeError);
    await expect(environment.resolvePath("hard.txt", "read")).resolves.toBeDefined();
  });

  it.skipIf(!isWindows)("rejects windows-specific forms", async () => {
    const { environment } = newEnvironment();
    for (const input of ["\\\\server\\share\\x", "\\??\\C:\\x", "src\\a.txt:stream", "src\\CON", "C:x"]) {
      await expect(environment.resolvePath(input, "read")).rejects.toBeInstanceOf(PathEscapeError);
    }
  });

  it.skipIf(!isWindows)("treats paths case-insensitively", async () => {
    const { root, environment } = newEnvironment();
    expect(environment.caseSensitive).toBe(false);
    const resolved = await environment.resolvePath("SRC\\A.TXT", "read");
    expect(resolved.real.toLowerCase()).toBe(path.join(root, "src", "a.txt").toLowerCase());
  });

  it.skipIf(process.platform !== "linux")("treats paths case-sensitively on linux", async () => {
    const { environment } = newEnvironment();
    expect(environment.caseSensitive).toBe(true);
    await expect(environment.resolvePath("SRC/a.txt", "read")).resolves.toMatchObject({ real: expect.stringContaining("SRC") as unknown });
  });
});

describe("creation", () => {
  it("rejects a missing root", () => {
    expect(() => createLocalEnvironment({ root: path.join(makeTempDir(), "missing") })).toThrow(/not an accessible directory/u);
  });

  it("rejects a file as root", () => {
    const root = makeTempDir();
    writeFileSync(path.join(root, "f"), "x");
    expect(() => createLocalEnvironment({ root: path.join(root, "f") })).toThrow(/not an accessible directory/u);
  });
});

describe("exec", () => {
  it("runs a program from PATH and captures output", async () => {
    const { environment } = newEnvironment();
    const result = await environment.exec(["node", "-e", "process.stdout.write('out');process.stderr.write('err');process.exit(3)"]);
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it("runs inside a subdirectory cwd", async () => {
    const { root, environment } = newEnvironment();
    const result = await environment.exec(["node", "-e", "process.stdout.write(process.cwd())"], { cwd: "src" });
    expect(result.stdout.toLowerCase()).toBe(path.join(root, "src").toLowerCase());
  });

  it("rejects a cwd outside the root", async () => {
    const { environment } = newEnvironment();
    await expect(environment.exec(["node", "-v"], { cwd: ".." })).rejects.toBeInstanceOf(PathEscapeError);
  });

  it("rejects a cwd that is a file", async () => {
    const { environment } = newEnvironment();
    await expect(environment.exec(["node", "-v"], { cwd: "src/a.txt" })).rejects.toMatchObject({ code: "invalid-cwd" });
  });

  it("rejects empty argv and NUL bytes", async () => {
    const { environment } = newEnvironment();
    await expect(environment.exec([])).rejects.toMatchObject({ code: "invalid-argv" });
    await expect(environment.exec(["node", "a\0b"])).rejects.toMatchObject({ code: "invalid-argv" });
  });

  it("reports an unknown command", async () => {
    const { environment } = newEnvironment();
    await expect(environment.exec(["definitely-not-a-real-command-xyz"])).rejects.toMatchObject({ code: "command-not-found" });
  });

  it("does not leak credentials into the child environment", async () => {
    const { environment } = newEnvironment(
      {},
      {
        baseEnv: { ...process.env, ANTHROPIC_API_KEY: "leak", XAI_API_KEY: "leak", SECRET_THING: "leak" },
      },
    );
    const result = await environment.exec(["node", "-e", "process.stdout.write(JSON.stringify(process.env))"]);
    const childEnv = JSON.parse(result.stdout) as Record<string, string>;
    const names = Object.keys(childEnv).map((name) => name.toUpperCase());
    expect(names).not.toContain("ANTHROPIC_API_KEY");
    expect(names).not.toContain("XAI_API_KEY");
    expect(names).not.toContain("SECRET_THING");
    expect(names).toContain("PATH");
    expect(childEnv["PYTHONUTF8"]).toBe("1");
    if (isWindows) {
      expect(names).toContain("USERNAME");
    }
  });

  it("applies per-call env on top of the allowlist", async () => {
    const { environment } = newEnvironment();
    const result = await environment.exec(["node", "-e", "process.stdout.write(process.env.BMA_PROBE ?? '')"], { env: { BMA_PROBE: "yes" } });
    expect(result.stdout).toBe("yes");
  });

  it("truncates output beyond one mebibyte and keeps the tail", async () => {
    const { environment } = newEnvironment();
    const result = await environment.exec([
      "node",
      "-e",
      "process.stdout.write('H'.repeat(10)+'x'.repeat(3*1024*1024)+'TAIL')",
    ]);
    expect(result.truncated).toBe(true);
    expect(result.stdout.startsWith("HHHHHHHHHH")).toBe(true);
    expect(result.stdout.endsWith("TAIL")).toBe(true);
    expect(result.stdout.length).toBeLessThan(2 * 1024 * 1024);
  });

  it("kills the process on timeout", async () => {
    const { environment } = newEnvironment();
    const result = await environment.exec(["node", "-e", "setInterval(()=>{},1000)"], { timeoutMs: 500 });
    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeLessThan(15_000);
  }, 30_000);

  it("kills the whole process tree on timeout", async () => {
    const { environment } = newEnvironment();
    const script = [
      "const {spawn}=require('node:child_process');",
      "const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});",
      "process.stdout.write(String(c.pid)+'\\n');",
      "setInterval(()=>{},1000);",
    ].join("");
    const result = await environment.exec(["node", "-e", script], { timeoutMs: 1500 });
    expect(result.timedOut).toBe(true);
    const pid = Number(result.stdout.trim().split(/\r?\n/u)[0]);
    expect(Number.isInteger(pid)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const alive = ((): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    })();
    expect(alive).toBe(false);
  }, 30_000);

  it("stops when the signal aborts", async () => {
    const { environment } = newEnvironment();
    const controller = new AbortController();
    const pending = environment.exec(["node", "-e", "setInterval(()=>{},1000)"], { signal: controller.signal, timeoutMs: 60_000 });
    setTimeout(() => {
      controller.abort();
    }, 300);
    const result = await pending;
    expect(result.timedOut).toBe(false);
    expect(result.exitCode === 0).toBe(false);
  }, 30_000);

  it("returns immediately for an already aborted signal", async () => {
    const { environment } = newEnvironment();
    const controller = new AbortController();
    controller.abort();
    const result = await environment.exec(["node", "-e", "setInterval(()=>{},1000)"], { signal: controller.signal });
    expect(result.exitCode === 0).toBe(false);
  });

  it("runs a program inside the workspace by relative path", async () => {
    if (isWindows) {
      return;
    }
    const { root, environment } = newEnvironment({ "tool.sh": "#!/bin/sh\necho inside\n" });
    chmodSync(path.join(root, "tool.sh"), 0o755);
    const result = await environment.exec(["./tool.sh"]);
    expect(result.stdout.trim()).toBe("inside");
  });

  it("refuses a path-like program outside the root", async () => {
    const { environment } = newEnvironment();
    await expect(environment.exec([process.execPath, "-v"])).rejects.toBeInstanceOf(PathEscapeError);
  });

  it.skipIf(process.platform === "win32")("ignores a PATH entry inside the workspace", async () => {
    const root = makeTempDir();
    mkdirSync(path.join(root, "bin"));
    writeFileSync(path.join(root, "bin", "evil-tool"), "#!/bin/sh\necho pwned\n");
    chmodSync(path.join(root, "bin", "evil-tool"), 0o755);
    const environment = createLocalEnvironment({
      root,
      baseEnv: { ...process.env, PATH: `${path.join(root, "bin")}${path.delimiter}${process.env["PATH"] ?? ""}` },
    });
    await expect(environment.exec(["evil-tool"])).rejects.toMatchObject({ code: "command-not-found" });
  });

  it.skipIf(!isWindows)("does not run a fake executable planted in the cwd or an in-root PATH entry", async () => {
    const root = makeTempDir();
    mkdirSync(path.join(root, "bin"));
    writeFileSync(path.join(root, "bin", "evil-tool.cmd"), "@echo pwned\r\n");
    writeFileSync(path.join(root, "evil-tool.exe"), "not a real executable");
    const environment = createLocalEnvironment({
      root,
      baseEnv: { ...process.env, Path: `${path.join(root, "bin")};${process.env["Path"] ?? process.env["PATH"] ?? ""}` },
    });
    await expect(environment.exec(["evil-tool"])).rejects.toMatchObject({ code: "command-not-found" });
  });

  it.skipIf(!isWindows)("runs a real cmd shim with allowlisted arguments and rejects unsafe ones", async () => {
    const { environment } = newEnvironment({ "echo-args.cmd": "@echo off\r\necho %1\r\n" });
    const ok = await environment.exec(["./echo-args.cmd", "hello"]);
    expect(ok.stdout.trim()).toBe("hello");
    for (const unsafe of ["", "a&b", 'a"b', "%PATH%", "a^b", "a b"]) {
      await expect(environment.exec(["./echo-args.cmd", unsafe])).rejects.toBeInstanceOf(ExecError);
    }
  });

  it("reports command-too-long for oversized arguments", async () => {
    const { environment } = newEnvironment();
    const huge = "x".repeat(isWindows ? 40_000 : 4 * 1024 * 1024);
    await expect(environment.exec(["node", "-e", "0", huge])).rejects.toMatchObject({ code: "command-too-long" });
  });

  it.skipIf(!hasCommand("python", ["--version"]))("passes UTF-8 through python", async () => {
    const { environment } = newEnvironment();
    const result = await environment.exec(["python", "-c", "print('xin chào đ')"]);
    expect(result.stdout.trim()).toBe("xin chào đ");
  });
});
