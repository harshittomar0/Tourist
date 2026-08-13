import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contentHashOf, toPersistedEntry } from "../hashing.js";
import { LocalStore, storeFilePath, upsertEntries } from "../store.js";
import { attributedRangesFixture } from "../__fixtures__/attributedRanges.fixture.js";
import type { PersistedEntry, PersistedStore, RepoBranchKey } from "../types.js";

const key: RepoBranchKey = { repoRoot: "/repo", branch: "feature/rename-fix" };

describe("storeFilePath", () => {
  it("slugifies branch names that contain slashes", () => {
    const p = storeFilePath("/base", key);
    expect(p).not.toContain("feature/rename-fix");
    expect(p.endsWith(".json")).toBe(true);
  });

  it("is stable for the same key", () => {
    expect(storeFilePath("/base", key)).toBe(storeFilePath("/base", key));
  });

  it("differs across repo roots even with the same branch name", () => {
    const other: RepoBranchKey = { ...key, repoRoot: "/other-repo" };
    expect(storeFilePath("/base", key)).not.toBe(storeFilePath("/base", other));
  });
});

describe("LocalStore", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "tourist-store-"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("returns an empty store when nothing has been saved yet", async () => {
    const store = new LocalStore(baseDir);
    const loaded = await store.load(key);
    expect(loaded.entries).toEqual([]);
    expect(loaded.repoRoot).toBe(key.repoRoot);
    expect(loaded.branch).toBe(key.branch);
  });

  it("round-trips entries through save/load", async () => {
    const store = new LocalStore(baseDir);
    const entries = attributedRangesFixture.map(toPersistedEntry);
    const initial = await store.load(key);
    const withEntries = upsertEntries(initial, entries);
    await store.save(withEntries);

    const reloaded = await store.load(key);
    expect(reloaded.entries).toHaveLength(entries.length);
    expect(new Set(reloaded.entries.map((e) => e.contentHash))).toEqual(new Set(entries.map((e) => e.contentHash)));
  });

  it("starts fresh rather than crashing on an unknown store version", async () => {
    const store = new LocalStore(baseDir);
    const entries = attributedRangesFixture.map(toPersistedEntry);
    await store.save(upsertEntries(await store.load(key), entries));

    const filePath = storeFilePath(baseDir, key);
    const { readFile, writeFile } = await import("node:fs/promises");
    const raw = JSON.parse(await readFile(filePath, "utf8"));
    raw.version = 999;
    await writeFile(filePath, JSON.stringify(raw), "utf8");

    const reloaded = await store.load(key);
    expect(reloaded.entries).toEqual([]);
  });
});

describe("upsertEntries", () => {
  function baseStore(): PersistedStore {
    return { version: 1 as const, repoRoot: "/repo", branch: "main", entries: [] };
  }

  function entryAt(fsPath: string, startLine: number, endLine: number, text: string, id: string): PersistedEntry {
    return {
      id,
      contentHash: contentHashOf(text),
      lastSeenFsPath: fsPath,
      range: { startLine, endLine },
      attribution: { author: "alice@example.com", tier: "verified", createdAt: 1, updatedAt: 1 }
    };
  }

  it("dedupes by (fsPath, range, contentHash) — same location and content, last write wins", () => {
    const entryA = toPersistedEntry(attributedRangesFixture[0]);
    const entryAUpdated = { ...entryA, attribution: { ...entryA.attribution, note: "revised" } };

    const afterFirst = upsertEntries(baseStore(), [entryA]);
    const afterSecond = upsertEntries(afterFirst, [entryAUpdated]);

    expect(afterSecond.entries).toHaveLength(1);
    expect(afterSecond.entries[0].attribution.note).toBe("revised");
  });

  it("keeps distinct-content entries separate", () => {
    const entries = attributedRangesFixture.map(toPersistedEntry);
    const result = upsertEntries(baseStore(), entries);
    expect(result.entries).toHaveLength(entries.length);
  });

  // CRITICAL regression: two entries with byte-identical text (a lone "}",
  // extremely common) at different locations must never collide, even
  // though contentHashOf() produces the exact same hash for both. Before
  // this fix, upsertByContentHash keyed purely on contentHash, so the second
  // entry silently overwrote the first here.
  it("does not collide two entries with identical text at different lines in the same file", () => {
    const closingBrace = entryAt("/repo/a.ts", 10, 10, "}", "range-A");
    const otherClosingBrace = entryAt("/repo/a.ts", 40, 40, "}", "range-B");
    expect(closingBrace.contentHash).toBe(otherClosingBrace.contentHash);

    const result = upsertEntries(baseStore(), [closingBrace, otherClosingBrace]);
    expect(result.entries).toHaveLength(2);
    expect(result.entries.map((e) => e.id).sort()).toEqual(["range-A", "range-B"]);
  });

  // Same identical-text collision, but across two entirely different files
  // -- the review report's exact repro ("across different files").
  it("does not collide two entries with identical text across different files", () => {
    const blankLineInA = entryAt("/repo/a.ts", 5, 5, "", "range-A");
    const blankLineInB = entryAt("/repo/b.ts", 5, 5, "", "range-B");
    expect(blankLineInA.contentHash).toBe(blankLineInB.contentHash);

    const result = upsertEntries(baseStore(), [blankLineInA, blankLineInB]);
    expect(result.entries).toHaveLength(2);
    expect(new Set(result.entries.map((e) => e.lastSeenFsPath))).toEqual(new Set(["/repo/a.ts", "/repo/b.ts"]));
  });

  // A file's older (location, content) entries stay in the store even after
  // a later save recomputes different spans for that same file -- e.g. an
  // edit re-shapes one wide span into two narrower ones. This is
  // deliberate, not a leak: it's exactly what lets a later `git stash pop`
  // (or an undo) that brings back the file's *older* exact text find a
  // still-valid, still-accurate historical entry for it (see
  // test/vscode-integration/git-reload.test.ts's stash push/pop round-trip
  // coverage for the end-to-end version of this). Only an exact repeat of
  // the same (location, content) collapses via last-write-wins; nothing
  // else is ever dropped here (`pruneExpired` in retention.ts is the only
  // thing that ages entries out, on a timer, independent of this key).
  it("keeps a file's older (location, content) spans after a later save recomputes different spans for the same file", () => {
    const untouchedFile = entryAt("/repo/untouched.ts", 0, 3, "unrelated block", "range-untouched");
    const wideSpan = entryAt("/repo/a.ts", 10, 24, "old wide span", "range-old");
    const afterFirstSave = upsertEntries(baseStore(), [untouchedFile, wideSpan]);
    expect(afterFirstSave.entries).toHaveLength(2);

    // /repo/a.ts re-saved: the old 10-24 span split into two narrower ones.
    const splitA = entryAt("/repo/a.ts", 10, 14, "new narrow span A", "range-new-a");
    const splitB = entryAt("/repo/a.ts", 16, 24, "new narrow span B", "range-new-b");
    const afterSecondSave = upsertEntries(afterFirstSave, [splitA, splitB]);

    const ids = afterSecondSave.entries.map((e) => e.id).sort();
    expect(ids).toEqual(["range-new-a", "range-new-b", "range-old", "range-untouched"]);
  });
});
