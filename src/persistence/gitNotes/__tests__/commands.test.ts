import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fetchAttributionNotes, pushAttributionNotes } from "../commands.js";
import { defaultGitRunner } from "../gitPlumbing.js";
import { readNote, writeNote } from "../notesStore.js";
import type { AttributionNote } from "../types.js";

function git(cwd: string, args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Tourist Test", "-c", "user.email=tourist-test@example.com", ...args],
    { cwd, encoding: "utf8" }
  ).trim();
}

function note(commit: string, tier: "verified" | "inferred" | "heuristic", updatedAt: number): AttributionNote {
  return {
    version: 1,
    commit,
    entries: [{ contentHash: "h1", range: { startLine: 1, endLine: 2 }, attribution: { author: "x", tier, createdAt: updatedAt, updatedAt } }]
  };
}

describe("push/fetch attribution notes (explicit commands, real remote)", () => {
  let parentDir: string;
  let bareDir: string;
  let repoADir: string;
  let repoBDir: string;
  let commitSha: string;

  beforeEach(async () => {
    parentDir = await mkdtemp(join(tmpdir(), "tourist-notes-remote-"));
    bareDir = join(parentDir, "origin.git");
    git(parentDir, ["init", "-q", "--bare", "-b", "main", bareDir]);

    repoADir = join(parentDir, "repo-a");
    git(parentDir, ["clone", "-q", bareDir, repoADir]);
    await writeFile(join(repoADir, "a.txt"), "hello\n");
    git(repoADir, ["add", "a.txt"]);
    git(repoADir, ["commit", "-q", "-m", "initial"]);
    commitSha = git(repoADir, ["rev-parse", "HEAD"]);
    git(repoADir, ["push", "-q", "origin", "main"]);

    repoBDir = join(parentDir, "repo-b");
    git(parentDir, ["clone", "-q", bareDir, repoBDir]);
  });

  afterEach(async () => {
    await rm(parentDir, { recursive: true, force: true });
  });

  it("pushAttributionNotes publishes the notes ref to the remote", async () => {
    await writeNote(defaultGitRunner, repoADir, commitSha, note(commitSha, "verified", 1));
    const result = await pushAttributionNotes(defaultGitRunner, repoADir, { enabled: true });
    expect(result).toEqual({ skipped: false });

    const onBare = git(bareDir, ["notes", "--ref=refs/notes/tourist-attribution", "show", commitSha]);
    expect(JSON.parse(onBare)).toEqual(note(commitSha, "verified", 1));
  });

  it("fetchAttributionNotes pulls remote notes into the local ref when there's nothing local yet", async () => {
    await writeNote(defaultGitRunner, repoADir, commitSha, note(commitSha, "verified", 1));
    await pushAttributionNotes(defaultGitRunner, repoADir, { enabled: true });

    const result = await fetchAttributionNotes(defaultGitRunner, repoBDir, { enabled: true });
    expect(result.skipped).toBe(false);
    if (!result.skipped) expect(result.mergedCommits).toEqual([commitSha]);

    const local = await readNote(defaultGitRunner, repoBDir, commitSha);
    expect(local).toEqual(note(commitSha, "verified", 1));
  });

  it("fetchAttributionNotes merges (tier-then-recency) instead of clobbering local notes", async () => {
    // repo A publishes a heuristic note; repo B independently wrote a verified one locally.
    await writeNote(defaultGitRunner, repoADir, commitSha, note(commitSha, "heuristic", 100));
    await pushAttributionNotes(defaultGitRunner, repoADir, { enabled: true });

    await writeNote(defaultGitRunner, repoBDir, commitSha, note(commitSha, "verified", 1));
    await fetchAttributionNotes(defaultGitRunner, repoBDir, { enabled: true });

    const merged = await readNote(defaultGitRunner, repoBDir, commitSha);
    expect(merged?.entries[0].attribution.tier).toBe("verified"); // local verified beats remote heuristic
  });

  it("does not leave the throwaway fetch ref behind", async () => {
    await writeNote(defaultGitRunner, repoADir, commitSha, note(commitSha, "verified", 1));
    await pushAttributionNotes(defaultGitRunner, repoADir, { enabled: true });
    await fetchAttributionNotes(defaultGitRunner, repoBDir, { enabled: true });

    const refs = git(repoBDir, ["for-each-ref", "refs/notes/"]);
    expect(refs).not.toContain("tourist-attribution-fetch-tmp");
  });
});
