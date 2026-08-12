import { contentHashOf } from "./hashing.js";
import type { PersistedStore } from "./types.js";

export interface RenameEvent {
  oldFsPath: string;
  newFsPath: string;
}

/**
 * Handles the common case: the editor (or a workspace watcher) told us a file
 * moved. Because entries are anchored by content hash, no data is at risk —
 * this only updates the display-only `lastSeenFsPath` bookkeeping.
 */
export function applyRenameEvents(store: PersistedStore, events: RenameEvent[]): PersistedStore {
  if (events.length === 0) return store;
  const renameByOldPath = new Map(events.map((e) => [e.oldFsPath, e.newFsPath]));
  return {
    ...store,
    entries: store.entries.map((entry) => {
      const newPath = renameByOldPath.get(entry.lastSeenFsPath);
      return newPath ? { ...entry, lastSeenFsPath: newPath } : entry;
    })
  };
}

/**
 * Fallback reconciliation for moves that happened outside the editor (e.g.
 * `git mv` from a terminal, or a rename event that was dropped). Given the
 * current contents of candidate files, relocate any entry whose
 * `lastSeenFsPath` no longer matches its stored content hash by searching for
 * that hash among the candidates. This is what makes "history survives a file
 * move" hold even without a rename event.
 */
export function reconcileOrphanedEntries(
  store: PersistedStore,
  currentFileContents: ReadonlyMap<string, string>
): PersistedStore {
  const hashToPaths = new Map<string, string[]>();
  for (const [fsPath, content] of currentFileContents) {
    const hash = contentHashOf(content);
    const list = hashToPaths.get(hash);
    if (list) list.push(fsPath);
    else hashToPaths.set(hash, [fsPath]);
  }

  return {
    ...store,
    entries: store.entries.map((entry) => {
      const stillThere = currentFileContents.get(entry.lastSeenFsPath);
      if (stillThere !== undefined && contentHashOf(stillThere) === entry.contentHash) {
        return entry; // nothing moved, content still matches at the known path
      }
      const candidates = hashToPaths.get(entry.contentHash);
      if (!candidates || candidates.length === 0) {
        return entry; // orphaned for now (file deleted, or content changed) — leave as-is
      }
      // Ambiguous match (duplicate content across files): keep current path rather than guess.
      const [best] = candidates;
      return candidates.length === 1 ? { ...entry, lastSeenFsPath: best } : entry;
    })
  };
}
