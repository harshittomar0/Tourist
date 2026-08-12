import type { PersistedStore } from "./types.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface RetentionOptions {
  /** Ported from Tourist's `retentionDays`. */
  retentionDays: number;
  now?: number;
}

/**
 * Drops entries whose attribution hasn't been touched in `retentionDays`.
 * `retentionDays <= 0` disables pruning entirely (kept forever), matching the
 * original retentionDays semantics where 0/undefined meant "no expiry".
 */
export function pruneExpired(store: PersistedStore, options: RetentionOptions): PersistedStore {
  if (!options.retentionDays || options.retentionDays <= 0) {
    return store;
  }
  const now = options.now ?? Date.now();
  const cutoff = now - options.retentionDays * MS_PER_DAY;
  return {
    ...store,
    entries: store.entries.filter((entry) => entry.attribution.updatedAt >= cutoff)
  };
}
