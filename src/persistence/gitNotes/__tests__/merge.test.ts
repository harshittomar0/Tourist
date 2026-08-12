import { describe, expect, it } from "vitest";
import { mergeEntry, mergeNotes } from "../merge.js";
import type { AttributionNote, AttributionNoteEntry } from "../types.js";

function entry(overrides: Partial<AttributionNoteEntry["attribution"]> & { contentHash?: string }): AttributionNoteEntry {
  return {
    contentHash: overrides.contentHash ?? "hash-a",
    range: { startLine: 1, endLine: 5 },
    attribution: {
      author: "someone@example.com",
      tier: overrides.tier ?? "heuristic",
      createdAt: overrides.createdAt ?? 1000,
      updatedAt: overrides.updatedAt ?? 1000
    }
  };
}

describe("mergeEntry", () => {
  it("higher tier wins regardless of recency", () => {
    const verified = entry({ tier: "verified", updatedAt: 1 });
    const heuristic = entry({ tier: "heuristic", updatedAt: 999999 });
    expect(mergeEntry(verified, heuristic)).toBe(verified);
    expect(mergeEntry(heuristic, verified)).toBe(verified);
  });

  it("inferred beats heuristic", () => {
    const inferred = entry({ tier: "inferred" });
    const heuristic = entry({ tier: "heuristic" });
    expect(mergeEntry(inferred, heuristic)).toBe(inferred);
  });

  it("falls back to recency when tiers tie", () => {
    const older = entry({ tier: "inferred", updatedAt: 100 });
    const newer = entry({ tier: "inferred", updatedAt: 200 });
    expect(mergeEntry(older, newer)).toBe(newer);
    expect(mergeEntry(newer, older)).toBe(newer);
  });
});

describe("mergeNotes", () => {
  const commit = "abc123";

  it("unions entries across two notes for the same commit", () => {
    const local: AttributionNote = { version: 1, commit, entries: [entry({ contentHash: "h1", tier: "heuristic" })] };
    const remote: AttributionNote = { version: 1, commit, entries: [entry({ contentHash: "h2", tier: "heuristic" })] };
    const merged = mergeNotes(local, remote);
    expect(merged.entries.map((e) => e.contentHash).sort()).toEqual(["h1", "h2"]);
  });

  it("applies the tier-then-recency policy per overlapping content hash", () => {
    const local: AttributionNote = {
      version: 1,
      commit,
      entries: [entry({ contentHash: "h1", tier: "heuristic", updatedAt: 5 })]
    };
    const remote: AttributionNote = {
      version: 1,
      commit,
      entries: [entry({ contentHash: "h1", tier: "verified", updatedAt: 1 })]
    };
    const merged = mergeNotes(local, remote);
    expect(merged.entries).toHaveLength(1);
    expect(merged.entries[0].attribution.tier).toBe("verified");
  });

  it("refuses to merge notes for different commits", () => {
    const local: AttributionNote = { version: 1, commit: "a", entries: [] };
    const remote: AttributionNote = { version: 1, commit: "b", entries: [] };
    expect(() => mergeNotes(local, remote)).toThrow(/commit mismatch/);
  });
});
