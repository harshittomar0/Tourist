import type { AttributionNote, AttributionNoteEntry } from "./types.js";

const TIER_RANK = { verified: 3, inferred: 2, heuristic: 1 } as const;

/**
 * Field-level conflict resolution for two attribution entries anchored on the
 * same content hash: higher tier wins, ties broken by recency
 * (`attribution.updatedAt`).
 */
export function mergeEntry(local: AttributionNoteEntry, remote: AttributionNoteEntry): AttributionNoteEntry {
  const localRank = TIER_RANK[local.attribution.tier];
  const remoteRank = TIER_RANK[remote.attribution.tier];
  if (localRank !== remoteRank) return localRank > remoteRank ? local : remote;
  return local.attribution.updatedAt >= remote.attribution.updatedAt ? local : remote;
}

/**
 * Merges two notes for the *same commit* (e.g. local vs. fetched-remote)
 * entry-by-entry via `mergeEntry`.
 *
 * PENDING Phase 0 experiment 7: this function defines the JSON-level merge
 * policy only. It does not yet decide *how* it gets invoked at the git level —
 * candidates are a custom `git notes merge -s manual` resolver, a
 * `merge=driver` config entry, or (current placeholder in commands.ts)
 * applying this in-process after a plain fetch instead of a real `git notes
 * merge`. Don't finalize the git-level wiring without experiment 7's findings.
 */
export function mergeNotes(local: AttributionNote, remote: AttributionNote): AttributionNote {
  if (local.commit !== remote.commit) {
    throw new Error(`mergeNotes: commit mismatch (${local.commit} vs ${remote.commit}) — not the same note`);
  }
  const byHash = new Map(local.entries.map((e) => [e.contentHash, e]));
  for (const entry of remote.entries) {
    const existing = byHash.get(entry.contentHash);
    byHash.set(entry.contentHash, existing ? mergeEntry(existing, entry) : entry);
  }
  return { version: 1, commit: local.commit, entries: [...byHash.values()] };
}
