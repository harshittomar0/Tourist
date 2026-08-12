import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toPersistedEntry } from "../hashing.js";
import { LocalStore, storeFilePath, upsertByContentHash } from "../store.js";
import { attributedRangesFixture } from "../__fixtures__/attributedRanges.fixture.js";
import type { RepoBranchKey } from "../types.js";

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
    const withEntries = upsertByContentHash(initial, entries);
    await store.save(withEntries);

    const reloaded = await store.load(key);
    expect(reloaded.entries).toHaveLength(entries.length);
    expect(new Set(reloaded.entries.map((e) => e.contentHash))).toEqual(new Set(entries.map((e) => e.contentHash)));
  });

  it("starts fresh rather than crashing on an unknown store version", async () => {
    const store = new LocalStore(baseDir);
    const entries = attributedRangesFixture.map(toPersistedEntry);
    await store.save(upsertByContentHash(await store.load(key), entries));

    const filePath = storeFilePath(baseDir, key);
    const { readFile, writeFile } = await import("node:fs/promises");
    const raw = JSON.parse(await readFile(filePath, "utf8"));
    raw.version = 999;
    await writeFile(filePath, JSON.stringify(raw), "utf8");

    const reloaded = await store.load(key);
    expect(reloaded.entries).toEqual([]);
  });
});

describe("upsertByContentHash", () => {
  it("dedupes by content hash — same content, last write wins", () => {
    const base = { version: 1 as const, repoRoot: "/repo", branch: "main", entries: [] };
    const entryA = toPersistedEntry(attributedRangesFixture[0]);
    const entryAUpdated = { ...entryA, attribution: { ...entryA.attribution, note: "revised" } };

    const afterFirst = upsertByContentHash(base, [entryA]);
    const afterSecond = upsertByContentHash(afterFirst, [entryAUpdated]);

    expect(afterSecond.entries).toHaveLength(1);
    expect(afterSecond.entries[0].attribution.note).toBe("revised");
  });

  it("keeps distinct-content entries separate", () => {
    const base = { version: 1 as const, repoRoot: "/repo", branch: "main", entries: [] };
    const entries = attributedRangesFixture.map(toPersistedEntry);
    const result = upsertByContentHash(base, entries);
    expect(result.entries).toHaveLength(entries.length);
  });
});
