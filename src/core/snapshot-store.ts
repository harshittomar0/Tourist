export interface SnapshotStore {
  getBaseline(docId: string): string | undefined;
  setBaseline(docId: string, content: string): void;
  hasBaseline(docId: string): boolean;
}

/**
 * The generalized content-snapshot/baseline store spanning every tracked
 * file in the workspace (Phase 1, per the always-on/workspace-wide tracking
 * decision) -- what the whole-file-diff ingestion path diffs a changed
 * file's new on-disk content against.
 *
 * Seeded **lazily**: `seed` is invoked only the first time a given `docId`'s
 * baseline is requested and not already known in-session, never eagerly for
 * every tracked file at activation, specifically to bound activation-time
 * cost on large repositories (validated for real in Phase 4's large-repo
 * benchmark, per PLAN1.md Phase 1's explicit trade-off).
 *
 * `seed` is expected to be wired by Agent C's extension.ts at integration
 * time to read Agent B's persisted content-hash history -- Agent A's own
 * code never imports src/persistence/ directly, so this defaults to a no-op
 * (always-undefined) seed until that wiring exists, which is fine: an
 * unseeded baseline just means the whole-file-diff path treats the file as
 * newly-tracked (previousContent "") the first time it's observed this
 * session, same as tourist-raw treats a first-seen file today.
 */
export function createSnapshotStore(seed?: (docId: string) => string | undefined): SnapshotStore {
  const snapshots = new Map<string, string>();
  return {
    getBaseline(docId: string): string | undefined {
      if (snapshots.has(docId)) return snapshots.get(docId);
      const seeded = seed?.(docId);
      if (seeded !== undefined) snapshots.set(docId, seeded);
      return seeded;
    },
    setBaseline(docId: string, content: string): void {
      snapshots.set(docId, content);
    },
    hasBaseline(docId: string): boolean {
      return snapshots.has(docId);
    },
  };
}
