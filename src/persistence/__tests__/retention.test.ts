import { describe, expect, it } from "vitest";
import { pruneExpired } from "../retention.js";
import { toPersistedEntry } from "../hashing.js";
import { attributedRangesFixture } from "../__fixtures__/attributedRanges.fixture.js";
import type { PersistedStore } from "../types.js";

const NOW = 1_700_200_000_000; // just after the fixture's freshest updatedAt

function storeWithFixture(): PersistedStore {
  return {
    version: 1,
    repoRoot: "/repo",
    branch: "main",
    entries: attributedRangesFixture.map(toPersistedEntry)
  };
}

describe("pruneExpired", () => {
  it("drops entries older than retentionDays", () => {
    const store = storeWithFixture();
    // With a 90-day window from NOW, both range-3 (~120 days stale) and
    // range-4-stale (~1157 days stale) fall outside it; only range-1/range-2 survive.
    const pruned = pruneExpired(store, { retentionDays: 90, now: NOW });
    expect(pruned.entries.map((e) => e.id).sort()).toEqual(["range-1", "range-2"]);
  });

  it("keeps everything when retentionDays is 0 (no expiry)", () => {
    const store = storeWithFixture();
    const pruned = pruneExpired(store, { retentionDays: 0, now: NOW });
    expect(pruned.entries).toHaveLength(store.entries.length);
  });

  it("keeps everything when retentionDays is negative (defensive no-op)", () => {
    const store = storeWithFixture();
    const pruned = pruneExpired(store, { retentionDays: -5, now: NOW });
    expect(pruned.entries).toHaveLength(store.entries.length);
  });

  it("drops everything when retentionDays is very small and all entries are old", () => {
    const store = storeWithFixture();
    const pruned = pruneExpired(store, { retentionDays: 1, now: NOW });
    expect(pruned.entries).toHaveLength(0);
  });
});
