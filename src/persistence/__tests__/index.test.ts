import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PersistenceManager } from "../index.js";
import { attributedRangesFixture } from "../__fixtures__/attributedRanges.fixture.js";
import type { RepoBranchKey } from "../types.js";

const key: RepoBranchKey = { repoRoot: "/repo", branch: "main" };

describe("PersistenceManager (Mode A end-to-end against the hand-written fixture)", () => {
  let baseDir: string;
  let manager: PersistenceManager;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "tourist-manager-"));
    // retentionDays: 0 (no expiry) here — pruning-against-the-real-clock is exercised
    // in retention.test.ts with an explicit `now`; the fixture's fixed 2023 timestamps
    // would otherwise all be pruned relative to whenever these tests actually run.
    manager = new PersistenceManager({ baseDir, retentionDays: 0 });
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("records all fixture ranges", async () => {
    const store = await manager.record(key, attributedRangesFixture);
    expect(store.entries).toHaveLength(attributedRangesFixture.length);
  });

  it("prunes relative to retentionDays on record", async () => {
    const strictManager = new PersistenceManager({ baseDir, retentionDays: 90 });
    const store = await strictManager.record(key, attributedRangesFixture);
    expect(store.entries.find((e) => e.id === "range-4-stale")).toBeUndefined();
  });

  it("survives a rename: the record for a moved file is still found by content, not path", async () => {
    await manager.record(key, attributedRangesFixture);
    const original = attributedRangesFixture.find((r) => r.id === "range-1")!;

    const afterRename = await manager.applyRenames(key, [{ oldFsPath: original.fsPath, newFsPath: "/repo/src/util/parsing.ts" }]);
    const moved = afterRename.entries.find((e) => e.id === "range-1")!;
    expect(moved.lastSeenFsPath).toBe("/repo/src/util/parsing.ts");
    expect(moved.attribution).toEqual(original.attribution);
  });

  it("keeps repo+branch stores isolated", async () => {
    await manager.record(key, attributedRangesFixture);
    const otherBranchKey: RepoBranchKey = { ...key, branch: "feature/other" };
    const otherStore = await manager.load(otherBranchKey);
    expect(otherStore.entries).toHaveLength(0);
  });
});
