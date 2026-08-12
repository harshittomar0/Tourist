/**
 * Pure, vscode-free coordinator for reconciling an already-open document
 * against persisted attribution after a git operation changed its content
 * or its (repoRoot, branch) key out from under the live engine -- the
 * "switching branches / stash push+pop loses all attribution" data-loss
 * bug. Kept out of extension.ts itself (which owns the actual `vscode.*`
 * wiring) so this sequencing -- invalidate the cached key, then re-restore
 * and reload every affected doc through that same, now-fresh key -- can be
 * exercised by a real `AttributionEngine` + `RealPersistenceAdapter` in
 * tests without needing the real `vscode` module.
 *
 * Two extension.ts call sites share this one function:
 *  - BranchWatcher's `onChange` (a real branch switch): every open doc
 *    under the affected repo's workspace folder(s).
 *  - `onDidChangeTextDocument`'s disk-write-during-suppression check (any
 *    other git op -- stash pop, rebase, ... -- that reverts one open doc's
 *    content without a branch change): just that one doc.
 */
import type { AttributedRange, RepoBranchKey } from "./contracts.ts";

export interface OpenDocSnapshot {
  docId: string;
  folderPath: string;
  text: string;
}

export interface GitReloadDeps {
  /** The *same* `Map` instance extension.ts's own `keyFor(folder)` reads
   * and writes. Invalidating entries here and letting `restore` re-resolve
   * through that identical cache is what closes the stale-key bug -- a
   * second, independent cache would just move the staleness elsewhere. */
  folderKeyCache: Map<string, RepoBranchKey>;
  /** Re-fetches persisted `AttributedRange[]` for `docId` against its
   * *current* content -- normally extension.ts's own `restoreFor`, called
   * again after the cache invalidation below so it resolves against the
   * now-current branch key rather than whatever was cached before. */
  restore: (docId: string) => Promise<AttributedRange[] | undefined>;
  /** Normally `engine.reload` -- overwrites the engine's live state for
   * `docId` outright, unlike `engine.open`, which no-ops once a doc is
   * already tracked. */
  reloadEngine: (docId: string, text: string, restore: AttributedRange[] | undefined) => void;
}

/**
 * Invalidates `deps.folderKeyCache` for every path in `affectedFolderPaths`,
 * then re-restores and reloads every doc in `openDocs` that lives under one
 * of those folders. `openDocs` may be a whole folder's worth of open
 * documents (a real branch change) or just the single document a disk-write
 * event was observed on (any other git op) -- both extension.ts call sites
 * need exactly this cache-then-reload sequence, just with a different
 * `openDocs` list.
 */
export async function reconcileAfterGitChange(
  deps: GitReloadDeps,
  affectedFolderPaths: readonly string[],
  openDocs: readonly OpenDocSnapshot[]
): Promise<void> {
  for (const folderPath of affectedFolderPaths) deps.folderKeyCache.delete(folderPath);

  const affected = openDocs.filter((doc) => affectedFolderPaths.includes(doc.folderPath));
  await Promise.all(
    affected.map(async (doc) => {
      const restored = await deps.restore(doc.docId);
      deps.reloadEngine(doc.docId, doc.text, restored);
    })
  );
}
