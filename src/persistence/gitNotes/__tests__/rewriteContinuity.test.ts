import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { defaultGitRunner } from "../gitPlumbing.js";
import { readNote, writeNote } from "../notesStore.js";
import {
  HOOK_MARKER,
  configureNotesRewrite,
  handlePostCommit,
  handlePostRewrite,
  installHook,
  parseRewriteStdin
} from "../rewriteContinuity.js";

function git(cwd: string, args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Tourist Test", "-c", "user.email=tourist-test@example.com", ...args],
    { cwd, encoding: "utf8" }
  ).trim();
}

describe("installHook", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "tourist-hooks-"));
    git(repoDir, ["init", "-q", "-b", "main"]);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("creates the hook file when none exists", async () => {
    const result = await installHook({ repoRoot: repoDir, hookName: "post-commit", invocationCommand: "echo tourist-ran" });
    expect(result.installed).toBe(true);
    const content = await readFile(result.hookPath, "utf8");
    expect(content).toContain(HOOK_MARKER);
    expect(content).toContain("echo tourist-ran");
  });

  it("appends to an existing hook (e.g. a husky-style wrapper) without clobbering it", async () => {
    const hookPath = join(repoDir, ".git", "hooks", "post-commit");
    const huskyLike = '#!/usr/bin/env sh\necho "husky ran first"\n';
    await writeFile(hookPath, huskyLike, "utf8");

    const result = await installHook({ repoRoot: repoDir, hookName: "post-commit", invocationCommand: "echo tourist-ran" });
    expect(result.installed).toBe(true);
    const content = await readFile(hookPath, "utf8");
    expect(content.startsWith(huskyLike)).toBe(true);
    expect(content).toContain("echo tourist-ran");
    expect(content.indexOf("husky ran first")).toBeLessThan(content.indexOf("tourist-ran"));
  });

  it("is idempotent — running twice doesn't duplicate the block", async () => {
    await installHook({ repoRoot: repoDir, hookName: "post-commit", invocationCommand: "echo tourist-ran" });
    const second = await installHook({ repoRoot: repoDir, hookName: "post-commit", invocationCommand: "echo tourist-ran" });
    expect(second.alreadyPresent).toBe(true);
    const content = await readFile(second.hookPath, "utf8");
    expect(content.split(HOOK_MARKER)).toHaveLength(2); // marker appears exactly once
  });

  it("actually runs both the pre-existing hook and ours when git invokes it", async () => {
    const hookPath = join(repoDir, ".git", "hooks", "post-commit");
    await writeFile(hookPath, '#!/usr/bin/env bash\necho "existing" >> observed.log\n', "utf8");
    await installHook({ repoRoot: repoDir, hookName: "post-commit", invocationCommand: 'echo "tourist" >> observed.log' });
    execFileSync("chmod", ["+x", hookPath]);

    await writeFile(join(repoDir, "a.txt"), "content\n");
    git(repoDir, ["add", "a.txt"]);
    git(repoDir, ["commit", "-q", "-m", "trigger hooks"]);

    const observed = await readFile(join(repoDir, "observed.log"), "utf8");
    expect(observed.trim().split("\n")).toEqual(["existing", "tourist"]);
  });
});

// Project root: src/persistence/gitNotes/__tests__ -> ../../../.. is the repo root.
const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const HOOK_RUNNER_PATH = join(REPO_ROOT, "dist", "persistence", "gitNotes", "hookRunner.js");

/**
 * handlePostCommit's cherry-pick detection reads `CHERRY_PICK_HEAD`, which
 * git's sequencer removes as part of its own cleanup immediately after the
 * hook fires (confirmed empirically — see SPIKE_NOTES.md-style investigation
 * in this task's notes). Calling the handler after `git cherry-pick` has
 * already returned is too late to see that file, so these tests install the
 * real hook and let git invoke it live, exactly like production usage would.
 * That means the hook has to shell out to *compiled* JS (Node's native TS
 * support won't resolve the `.js`-suffixed relative imports our source uses
 * for the real build), so this suite builds the project once up front.
 */
describe("handlePostCommit — cherry-pick continuity, invoked as a real live hook", () => {
  let repoDir: string;
  let sourceSha: string;

  beforeAll(() => {
    execFileSync("npx", ["tsc", "-p", "tsconfig.json"], { cwd: REPO_ROOT });
  }, 60_000);

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "tourist-cherry-"));
    git(repoDir, ["init", "-q", "-b", "main"]);
    git(repoDir, ["config", "tourist.attributionSharing.enabled", "true"]);
    await installHook({
      repoRoot: repoDir,
      hookName: "post-commit",
      invocationCommand: `node "${HOOK_RUNNER_PATH}" post-commit 2>>tourist-hook-stderr.log`
    });
    await writeFile(join(repoDir, "a.txt"), "a\n");
    git(repoDir, ["add", "a.txt"]);
    git(repoDir, ["commit", "-q", "-m", "first"]);
    await writeFile(join(repoDir, "b.txt"), "b\n");
    git(repoDir, ["add", "b.txt"]);
    git(repoDir, ["commit", "-q", "-m", "second"]);
    sourceSha = git(repoDir, ["rev-parse", "HEAD"]);
    git(repoDir, ["checkout", "-q", "-b", "other", "HEAD~1"]);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("copies the note when cherry-picked with -x (trailer present)", async () => {
    await writeNote(defaultGitRunner, repoDir, sourceSha, { version: 1, commit: sourceSha, entries: [] });
    git(repoDir, ["cherry-pick", "-x", sourceSha]);

    const newSha = git(repoDir, ["rev-parse", "HEAD"]);
    const copied = await readNote(defaultGitRunner, repoDir, newSha);
    expect(copied).toEqual({ version: 1, commit: sourceSha, entries: [] });
  });

  it("flags the gap visibly when cherry-picked WITHOUT -x (no trailer to trace)", async () => {
    git(repoDir, ["cherry-pick", sourceSha]); // no -x

    const stderrLog = await readFile(join(repoDir, "tourist-hook-stderr.log"), "utf8");
    expect(stderrLog).toMatch(/without "-x"/);
    expect(stderrLog).toMatch(/continuity/);
  });

  it("does not touch notes for a plain (non-cherry-pick) commit", async () => {
    await writeFile(join(repoDir, "c.txt"), "c\n");
    git(repoDir, ["add", "c.txt"]);
    git(repoDir, ["commit", "-q", "-m", "plain"]);

    const newSha = git(repoDir, ["rev-parse", "HEAD"]);
    const note = await readNote(defaultGitRunner, repoDir, newSha);
    expect(note).toBeUndefined();
  });
});

describe("handlePostCommit — direct unit tests of the handler logic (config gating, message content)", () => {
  it("returns not-a-cherry-pick outside of any cherry-pick sequencer state", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "tourist-cherry-direct-"));
    try {
      git(repoDir, ["init", "-q", "-b", "main"]);
      await writeFile(join(repoDir, "a.txt"), "a\n");
      git(repoDir, ["add", "a.txt"]);
      git(repoDir, ["commit", "-q", "-m", "first"]);

      const result = await handlePostCommit(defaultGitRunner, repoDir, { enabled: true }, () => {});
      expect(result).toEqual({ action: "not-a-cherry-pick" });
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });
});

describe("handlePostRewrite — amend/rebase safety net", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "tourist-rewrite-"));
    git(repoDir, ["init", "-q", "-b", "main"]);
    await writeFile(join(repoDir, "a.txt"), "a\n");
    git(repoDir, ["add", "a.txt"]);
    git(repoDir, ["commit", "-q", "-m", "first"]);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("parses git's real post-rewrite stdin format", () => {
    expect(parseRewriteStdin("aaaa1111 bbbb2222\ncccc3333 dddd4444\n")).toEqual([
      { oldSha: "aaaa1111", newSha: "bbbb2222" },
      { oldSha: "cccc3333", newSha: "dddd4444" }
    ]);
  });

  it("copies a note as a safety net when the builtin notes.rewrite config wasn't set", async () => {
    const oldSha = git(repoDir, ["rev-parse", "HEAD"]);
    await writeNote(defaultGitRunner, repoDir, oldSha, { version: 1, commit: oldSha, entries: [] });

    git(repoDir, ["commit", "--amend", "-q", "-m", "first (amended)"]);
    const newSha = git(repoDir, ["rev-parse", "HEAD"]);

    const result = await handlePostRewrite(defaultGitRunner, repoDir, { enabled: true }, `${oldSha} ${newSha}\n`);
    expect(result).toEqual({ checked: [{ oldSha, newSha }], safetyNetCopies: [{ oldSha, newSha }] });

    const copied = await readNote(defaultGitRunner, repoDir, newSha);
    expect(copied).toEqual({ version: 1, commit: oldSha, entries: [] });
  });

  it("does nothing extra when the new commit already has a note (builtin copy already ran)", async () => {
    const oldSha = git(repoDir, ["rev-parse", "HEAD"]);
    git(repoDir, ["commit", "--amend", "-q", "-m", "first (amended)"]);
    const newSha = git(repoDir, ["rev-parse", "HEAD"]);
    await writeNote(defaultGitRunner, repoDir, newSha, { version: 1, commit: newSha, entries: [] });

    const result = await handlePostRewrite(defaultGitRunner, repoDir, { enabled: true }, `${oldSha} ${newSha}\n`);
    expect(result).toEqual({ checked: [{ oldSha, newSha }], safetyNetCopies: [] });
  });
});

describe("configureNotesRewrite — confirms git's builtin note-copying end to end", () => {
  let repoDir: string;
  let baseSha: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "tourist-configure-"));
    git(repoDir, ["init", "-q", "-b", "main"]);
    await writeFile(join(repoDir, "a.txt"), "a\n");
    git(repoDir, ["add", "a.txt"]);
    git(repoDir, ["commit", "-q", "-m", "first"]);
    baseSha = git(repoDir, ["rev-parse", "HEAD"]);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("makes git itself carry a note across `commit --amend`", async () => {
    await configureNotesRewrite(defaultGitRunner, repoDir);
    await writeNote(defaultGitRunner, repoDir, baseSha, { version: 1, commit: baseSha, entries: [] });

    git(repoDir, ["commit", "--amend", "-q", "-m", "first (amended)"]);
    const newSha = git(repoDir, ["rev-parse", "HEAD"]);

    const onNew = await readNote(defaultGitRunner, repoDir, newSha);
    expect(onNew).toEqual({ version: 1, commit: baseSha, entries: [] });
  });
});
