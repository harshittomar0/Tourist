import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultGitRunner } from "../gitPlumbing.js";
import { copyNote, listNotedObjects, readNote, upsertNoteEntries, writeNote } from "../notesStore.js";
import type { AttributionNote } from "../types.js";

function git(cwd: string, args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Tourist Test", "-c", "user.email=tourist-test@example.com", ...args],
    { cwd, encoding: "utf8" }
  ).trim();
}

describe("notesStore against a real git repo", () => {
  let repoDir: string;
  let commitSha: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "tourist-notes-"));
    git(repoDir, ["init", "-q", "-b", "main"]);
    await writeFile(join(repoDir, "a.txt"), "hello\n");
    git(repoDir, ["add", "a.txt"]);
    git(repoDir, ["commit", "-q", "-m", "initial"]);
    commitSha = git(repoDir, ["rev-parse", "HEAD"]);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("returns undefined for a commit with no note", async () => {
    const note = await readNote(defaultGitRunner, repoDir, commitSha);
    expect(note).toBeUndefined();
  });

  it("round-trips a note through writeNote/readNote", async () => {
    const note: AttributionNote = {
      version: 1,
      commit: commitSha,
      entries: [
        {
          contentHash: "hash-1",
          range: { startLine: 1, endLine: 3 },
          attribution: { author: "a@example.com", tier: "verified", createdAt: 1, updatedAt: 1 }
        }
      ]
    };
    await writeNote(defaultGitRunner, repoDir, commitSha, note);
    const read = await readNote(defaultGitRunner, repoDir, commitSha);
    expect(read).toEqual(note);
  });

  it("stores structured JSON per-commit, not a full-file snapshot", async () => {
    const note: AttributionNote = { version: 1, commit: commitSha, entries: [] };
    await writeNote(defaultGitRunner, repoDir, commitSha, note);
    const raw = git(repoDir, ["notes", "--ref=refs/notes/tourist-attribution", "show", commitSha]);
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(JSON.parse(raw)).toEqual(note);
  });

  it("upsertNoteEntries merges by content hash using tier-then-recency", async () => {
    await upsertNoteEntries(defaultGitRunner, repoDir, commitSha, [
      { contentHash: "h1", range: { startLine: 1, endLine: 2 }, attribution: { author: "a", tier: "heuristic", createdAt: 1, updatedAt: 1 } }
    ]);
    const merged = await upsertNoteEntries(defaultGitRunner, repoDir, commitSha, [
      { contentHash: "h1", range: { startLine: 1, endLine: 2 }, attribution: { author: "b", tier: "verified", createdAt: 2, updatedAt: 2 } },
      { contentHash: "h2", range: { startLine: 5, endLine: 6 }, attribution: { author: "c", tier: "heuristic", createdAt: 3, updatedAt: 3 } }
    ]);
    expect(merged.entries).toHaveLength(2);
    const h1 = merged.entries.find((e) => e.contentHash === "h1")!;
    expect(h1.attribution.tier).toBe("verified"); // verified beat the earlier heuristic entry
  });

  it("copyNote copies a note from one commit to another", async () => {
    await writeFile(join(repoDir, "b.txt"), "second\n");
    git(repoDir, ["add", "b.txt"]);
    git(repoDir, ["commit", "-q", "-m", "second"]);
    const secondSha = git(repoDir, ["rev-parse", "HEAD"]);

    const note: AttributionNote = { version: 1, commit: commitSha, entries: [] };
    await writeNote(defaultGitRunner, repoDir, commitSha, note);

    const copied = await copyNote(defaultGitRunner, repoDir, commitSha, secondSha);
    expect(copied).toBe(true);
    const onSecond = await readNote(defaultGitRunner, repoDir, secondSha);
    expect(onSecond).toEqual({ ...note, commit: commitSha }); // copy preserves blob content verbatim
  });

  it("copyNote returns false when the source has no note", async () => {
    const copied = await copyNote(defaultGitRunner, repoDir, commitSha, commitSha);
    expect(copied).toBe(false);
  });

  it("listNotedObjects lists commits that have a note under the ref", async () => {
    await writeNote(defaultGitRunner, repoDir, commitSha, { version: 1, commit: commitSha, entries: [] });
    const listed = await listNotedObjects(defaultGitRunner, repoDir);
    expect(listed).toEqual([commitSha]);
  });
});
