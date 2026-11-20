import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ChangesetTooLargeError } from "@betamultiagent/core";
import { describe, expect, it } from "vitest";
import { createRepoOps } from "../src/index.js";
import { git, initRepo, isolatedGitEnv, makeTempDir, registerCleanup, writeTree } from "./helpers.js";

registerCleanup();

function setup(options: { identity?: boolean; maxEntries?: number; files?: Record<string, string> } = {}) {
  const home = makeTempDir("bma-home-");
  const env = isolatedGitEnv(home);
  const root = makeTempDir("bma-repo-");
  const state = makeTempDir("bma-state-");
  initRepo(root, env, options.identity ?? true);
  writeTree(root, { "README.md": "base\n", ".gitignore": "node_modules/\n*.log\n", ...(options.files ?? {}) });
  git(root, ["add", "--all"], env);
  git(root, ["-c", "user.name=Seed", "-c", "user.email=seed@example.invalid", "commit", "-q", "-m", "seed"], env);
  const repoOps = createRepoOps({
    repoRoot: root,
    hooksDir: path.join(state, "hooks"),
    worktreesDir: path.join(state, "worktrees"),
    baseEnv: env,
    ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
  });
  return { env, root, state, repoOps };
}

describe("preflight", () => {
  it("reports the base commit, git dirs and a config fingerprint", async () => {
    const { env, root, repoOps } = setup();
    const result = await repoOps.preflight();
    expect(result.baseCommit).toBe(git(root, ["rev-parse", "HEAD"], env).trim());
    expect(result.root.toLowerCase()).toBe(root.toLowerCase());
    expect(result.configFingerprint).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("fails clearly for a directory that is not a repository", async () => {
    const plain = makeTempDir();
    const repoOps = createRepoOps({ repoRoot: plain, hooksDir: path.join(plain, "h"), worktreesDir: path.join(plain, "w") });
    await expect(repoOps.preflight()).rejects.toThrow(/not a usable git repository/u);
    expect((await repoOps.checkIntegrity()).ok).toBe(false);
  });
});

describe("changes", () => {
  it("lists modified, added and untracked files but not ignored ones", async () => {
    const { root, repoOps } = setup();
    writeTree(root, { "README.md": "changed\n", "new.txt": "n\n", "dir/inner.txt": "i\n", "debug.log": "x\n", "node_modules/p/i.js": "x\n" });
    const changed = await repoOps.changedPaths("HEAD");
    expect(changed).toEqual(["README.md", "dir/inner.txt", "new.txt"]);
  });

  it("reports ignored entries, collapsing node_modules into a single entry", async () => {
    const { root, repoOps } = setup();
    writeTree(root, { "debug.log": "x\n", "node_modules/a/1.js": "1", "node_modules/a/2.js": "2" });
    const ignored = await repoOps.listIgnored();
    expect(ignored).toContain("debug.log");
    expect(ignored.some((entry) => entry.startsWith("node_modules/"))).toBe(true);
    expect(ignored).not.toContain("README.md");
  });

  it("checks ignore rules for given paths", async () => {
    const { repoOps } = setup();
    expect(await repoOps.isIgnored(["a.log", "a.txt", "node_modules/x"])).toEqual(["a.log", "node_modules/x"]);
    expect(await repoOps.isIgnored([])).toEqual([]);
  });

  it("handles unusual file names", async () => {
    const { root, repoOps } = setup();
    writeTree(root, { "sp ace.txt": "x", "tiếng việt.txt": "x" });
    const changed = await repoOps.changedPaths("HEAD");
    expect(changed).toContain("sp ace.txt");
    expect(changed).toContain("tiếng việt.txt");
  });

  it("throws ChangesetTooLargeError when the limit is exceeded", async () => {
    const { root, repoOps } = setup({ maxEntries: 3 });
    writeTree(root, { "1.txt": "", "2.txt": "", "3.txt": "", "4.txt": "" });
    await expect(repoOps.changedPaths("HEAD")).rejects.toBeInstanceOf(ChangesetTooLargeError);
    await expect(repoOps.isIgnored(["a", "b", "c", "d"])).rejects.toBeInstanceOf(ChangesetTooLargeError);
  });

  it("rejects revisions that look like options", async () => {
    const { repoOps } = setup();
    await expect(repoOps.changedPaths("--output=evil")).rejects.toThrow(/invalid revision/u);
    await expect(repoOps.diff("-p", 100)).rejects.toThrow(/invalid revision/u);
  });
});

describe("diff", () => {
  it("returns the diff text and numstat entries", async () => {
    const { root, repoOps } = setup();
    writeTree(root, { "README.md": "base\nmore\n" });
    const result = await repoOps.diff("HEAD", 100_000);
    expect(result.truncated).toBe(false);
    expect(result.text).toContain("+more");
    const stat = await repoOps.diffStat("HEAD");
    expect(stat).toContainEqual({ path: "README.md", added: 1, removed: 0 });
  });

  it("reports binary files with null counts after staging", async () => {
    const { root, repoOps } = setup();
    writeFileSync(path.join(root, "bin.dat"), Buffer.from([0, 1, 2, 3]));
    await repoOps.stageAll();
    const stat = await repoOps.diffStat("HEAD");
    expect(stat).toContainEqual({ path: "bin.dat", added: null, removed: null });
  });

  it("truncates output at the byte limit", async () => {
    const { root, repoOps } = setup();
    writeTree(root, { "README.md": "line\n".repeat(5000) });
    const result = await repoOps.diff("HEAD", 200);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(200);
  });

  it("does not run an external diff driver configured in the repository", async () => {
    const { env, root, repoOps } = setup();
    const marker = path.join(root, "external-ran.txt");
    git(root, ["config", "diff.external", `node -e "require('fs').writeFileSync('${marker.replace(/\\/gu, "/")}','x')"`], env);
    writeTree(root, { "README.md": "changed\n" });
    await repoOps.diff("HEAD", 10_000);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("commit", () => {
  it("stages and commits changes", async () => {
    const { env, root, repoOps } = setup();
    writeTree(root, { "feature.txt": "f\n" });
    await repoOps.stageAll();
    const result = await repoOps.commit("add feature");
    expect(result).toEqual({ committed: true, commit: git(root, ["rev-parse", "HEAD"], env).trim() });
    expect(git(root, ["log", "-1", "--format=%s"], env).trim()).toBe("add feature");
  });

  it("reports nothing to commit", async () => {
    const { repoOps } = setup();
    await repoOps.stageAll();
    const result = await repoOps.commit("empty");
    expect(result.committed).toBe(false);
  });

  it("returns a reason instead of throwing when no identity is configured", async () => {
    const { root, repoOps } = setup({ identity: false });
    writeTree(root, { "feature.txt": "f\n" });
    await repoOps.stageAll();
    const result = await repoOps.commit("no identity");
    expect(result.committed).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("rejects an empty message", async () => {
    const { repoOps } = setup();
    await expect(repoOps.commit("  ")).rejects.toThrow(/must not be empty/u);
  });

  it("does not run repository hooks", async () => {
    const { root, repoOps } = setup();
    const marker = path.join(root, "hook-ran.txt");
    const hooks = path.join(root, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    const script = `#!/bin/sh\necho x > "${marker.replace(/\\/gu, "/")}"\nexit 1\n`;
    writeFileSync(path.join(hooks, "pre-commit"), script, { mode: 0o755 });
    writeFileSync(path.join(hooks, "pre-commit.bat"), "@echo off\r\nexit /b 1\r\n");
    writeTree(root, { "feature.txt": "f\n" });
    await repoOps.stageAll();
    const result = await repoOps.commit("with hooks present");
    expect(result.committed).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("worktrees", () => {
  it("creates, commits in and removes a worktree and branch", async () => {
    const { env, root, state, repoOps } = setup();
    const worktree = await repoOps.addWorktree("run1", "HEAD");
    expect(worktree.branch).toBe("bma/run1");
    expect(worktree.path.toLowerCase().startsWith(state.toLowerCase())).toBe(true);
    expect(existsSync(path.join(worktree.path, "README.md"))).toBe(true);
    expect(git(root, ["branch", "--list", "bma/run1"], env)).toContain("bma/run1");

    writeFileSync(path.join(worktree.path, "work.txt"), "w\n");
    await repoOps.removeWorktree(worktree.path, { force: true });
    expect(existsSync(worktree.path)).toBe(false);
    await repoOps.deleteBranch(worktree.branch);
    expect(git(root, ["branch", "--list", "bma/run1"], env).trim()).toBe("");
  });

  it("rejects unsafe run ids and branch names", async () => {
    const { repoOps } = setup();
    await expect(repoOps.addWorktree("../evil", "HEAD")).rejects.toThrow(/invalid run id/u);
    await expect(repoOps.addWorktree("a b", "HEAD")).rejects.toThrow(/invalid run id/u);
    await expect(repoOps.deleteBranch("main")).rejects.toThrow(/only bma/u);
  });

  it("refuses to remove a path outside the worktrees directory", async () => {
    const { root, repoOps } = setup();
    await expect(repoOps.removeWorktree(root, { force: true })).rejects.toThrow(/outside the worktrees directory/u);
  });
});

describe("checkIntegrity", () => {
  it("is ok for an untouched repository", async () => {
    const { repoOps } = setup();
    expect(await repoOps.checkIntegrity()).toEqual({ ok: true, problems: [] });
  });

  it("detects a changed git configuration", async () => {
    const { env, root, repoOps } = setup();
    expect((await repoOps.checkIntegrity()).ok).toBe(true);
    git(root, ["config", "core.fsmonitor", "node evil.js"], env);
    const report = await repoOps.checkIntegrity();
    expect(report.ok).toBe(false);
    expect(report.problems.join(" ")).toContain("configuration changed");
  });

  it("does not execute a core.fsmonitor command set in the repository", async () => {
    const { env, root, repoOps } = setup();
    const marker = path.join(root, "fsmonitor-ran.txt");
    git(root, ["config", "core.fsmonitor", `node -e "require('fs').writeFileSync('${marker.replace(/\\/gu, "/")}','x')"`], env);
    writeTree(root, { "new.txt": "n\n" });
    await repoOps.changedPaths("HEAD");
    await repoOps.listIgnored();
    expect(existsSync(marker)).toBe(false);
  });

  it("detects a modified .git file in a worktree", async () => {
    const { repoOps } = setup();
    const worktree = await repoOps.addWorktree("run2", "HEAD");
    expect((await repoOps.checkIntegrity()).ok).toBe(true);
    rmSync(path.join(worktree.path, ".git"), { force: true });
    writeFileSync(path.join(worktree.path, ".git"), "gitdir: /somewhere/else\n");
    const report = await repoOps.checkIntegrity();
    expect(report.ok).toBe(false);
    expect(report.problems.join(" ")).toContain("was modified");
  });
});
