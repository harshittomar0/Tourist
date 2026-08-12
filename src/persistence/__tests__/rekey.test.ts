import { describe, expect, it } from "vitest";
import { toPersistedEntry } from "../hashing.js";
import { applyRenameEvents, reconcileOrphanedEntries } from "../rekey.js";
import { attributedRangesFixture } from "../__fixtures__/attributedRanges.fixture.js";
import type { PersistedStore } from "../types.js";

function storeWithFixture(): PersistedStore {
  return {
    version: 1,
    repoRoot: "/repo",
    branch: "main",
    entries: attributedRangesFixture.map(toPersistedEntry)
  };
}

describe("applyRenameEvents", () => {
  it("updates lastSeenFsPath without touching contentHash or attribution", () => {
    const store = storeWithFixture();
    const target = store.entries.find((e) => e.id === "range-1")!;
    const renamed = applyRenameEvents(store, [{ oldFsPath: target.lastSeenFsPath, newFsPath: "/repo/src/util/parsing.ts" }]);

    const after = renamed.entries.find((e) => e.id === "range-1")!;
    expect(after.lastSeenFsPath).toBe("/repo/src/util/parsing.ts");
    expect(after.contentHash).toBe(target.contentHash);
    expect(after.attribution).toEqual(target.attribution);
  });

  it("leaves entries untouched when no rename matches", () => {
    const store = storeWithFixture();
    const result = applyRenameEvents(store, [{ oldFsPath: "/repo/nonexistent.ts", newFsPath: "/repo/still-nonexistent.ts" }]);
    expect(result).toEqual(store);
  });

  it("is a no-op fast-path for an empty event list", () => {
    const store = storeWithFixture();
    expect(applyRenameEvents(store, [])).toBe(store);
  });
});

describe("reconcileOrphanedEntries", () => {
  it("relocates an entry whose file moved without emitting a rename event", () => {
    const store = storeWithFixture();
    const target = store.entries.find((e) => e.id === "range-1")!;
    const originalRange = attributedRangesFixture.find((r) => r.id === "range-1")!;

    // File no longer exists at the old path; identical content now lives elsewhere (e.g. `git mv` from a terminal).
    const currentFileContents = new Map<string, string>([["/repo/src/util/parse2.ts", originalRange.text]]);

    const result = reconcileOrphanedEntries(store, currentFileContents);
    const after = result.entries.find((e) => e.id === "range-1")!;
    expect(after.lastSeenFsPath).toBe("/repo/src/util/parse2.ts");
  });

  it("leaves an entry alone when its content still matches at the known path", () => {
    const store = storeWithFixture();
    const target = store.entries.find((e) => e.id === "range-1")!;
    const originalRange = attributedRangesFixture.find((r) => r.id === "range-1")!;
    const currentFileContents = new Map<string, string>([[target.lastSeenFsPath, originalRange.text]]);

    const result = reconcileOrphanedEntries(store, currentFileContents);
    expect(result.entries.find((e) => e.id === "range-1")!.lastSeenFsPath).toBe(target.lastSeenFsPath);
  });

  it("refuses to guess when content hash matches multiple candidate files", () => {
    const store = storeWithFixture();
    const target = store.entries.find((e) => e.id === "range-1")!;
    const originalRange = attributedRangesFixture.find((r) => r.id === "range-1")!;
    const currentFileContents = new Map<string, string>([
      ["/repo/src/util/copy-a.ts", originalRange.text],
      ["/repo/src/util/copy-b.ts", originalRange.text]
    ]);

    const result = reconcileOrphanedEntries(store, currentFileContents);
    // Ambiguous — stays at its last known (now-stale) path rather than an unverifiable guess.
    expect(result.entries.find((e) => e.id === "range-1")!.lastSeenFsPath).toBe(target.lastSeenFsPath);
  });

  it("leaves an orphan alone when the content simply no longer exists anywhere", () => {
    const store = storeWithFixture();
    const target = store.entries.find((e) => e.id === "range-1")!;
    const result = reconcileOrphanedEntries(store, new Map());
    expect(result.entries.find((e) => e.id === "range-1")!.lastSeenFsPath).toBe(target.lastSeenFsPath);
  });
});
