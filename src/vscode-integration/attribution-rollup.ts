/**
 * Shared workspace-wide aggregation, factored out because the status-bar
 * rollup (Phase 3, contract §5) and the new workspace-level attribution view
 * (Phase 3's "NEW" bullet) both need the exact same answer to "what's the
 * current ai/human/external state of every tracked file in this workspace,
 * including ones never opened this session" -- computing it twice with
 * subtly different merge logic would be a bug waiting to happen.
 *
 * Merge rule (mirrors tourist-raw's `collectAttributionStats` in its
 * extension.ts): the live engine's state wins for any docId it already
 * knows about (freshest -- covers open documents and any tracked file the
 * whole-file-diff watcher has touched this session); Agent B's persisted
 * history fills in every other tracked docId the engine hasn't loaded yet
 * (lazy snapshot seeding means that's expected, not a bug -- see the
 * `listPersisted` doc comment in contracts.ts).
 */
import type { AttributedRange, EngineLike, ExclusionPredicate, PersistenceLike, RepoBranchKey } from "./contracts.ts";
import { computeLineBuckets, type OffsetToLine } from "./line-buckets.ts";
import { addStats, computeStats, EMPTY_STATS, type AttributionStats } from "./stats.ts";

export interface FileRollup {
  docId: string;
  stats: AttributionStats;
}

export interface WorkspaceRollup {
  files: FileRollup[];
  total: AttributionStats;
}

export interface FolderScope {
  /** Absolute filesystem path of the workspace folder root. */
  path: string;
  key: RepoBranchKey;
}

export interface CollectRollupOptions {
  engine: EngineLike;
  persistence: PersistenceLike;
  folders: readonly FolderScope[];
  /** Contract §1c's tracking-scope predicate -- Agent C's UI must reuse
   * Agent A's real predicate rather than reimplement exclusion logic, per
   * PLAN1.md ("Agent C's workspace-level view ... must call this same
   * predicate"). Optional here only because the mock build has no real
   * predicate to inject yet; omitting it is not a valid end state. */
  isTracked?: ExclusionPredicate["isTracked"];
  /**
   * Resolves a live-engine docId to something that can convert its
   * character offsets into line numbers (real usage: the open
   * `vscode.TextDocument`, if any). `persistence.listPersisted()`'s
   * `AttributedRange`s are already 1-unit-per-line pseudo-offsets (see that
   * method's own doc comment in persistence-adapter.ts); `engine.getRanges()`'s
   * are real character offsets. Without converting the live side to the same
   * line-unit before summing, `addStats` mixes two different units into one
   * "total" -- a workspace with any open file gets a percentage dominated by
   * that file's raw character count, arithmetically meaningless next to a
   * closed file's line count (REVIEW_SENIOR.md finding #5). Optional, and
   * character-based `computeStats` remains the fallback for a live docId this
   * resolves to `undefined` for (e.g. a file the whole-file-diff watcher has
   * touched this session but that has never had an open document, so there is
   * no `vscode.TextDocument` to convert offsets with) -- a real, smaller
   * residual gap, not silently pretended away.
   */
  getDocument?: (docId: string) => OffsetToLine | undefined;
}

/** Character-offset ranges -> the same 1-unit-per-line counting
 * `persistence.listPersisted()`'s pseudo-offsets already use, via
 * `computeLineBuckets`. Falls back to raw `computeStats` when no document is
 * available to convert offsets with. */
function statsFor(ranges: readonly AttributedRange[], doc: OffsetToLine | undefined) {
  if (!doc) return computeStats(ranges);
  const buckets = computeLineBuckets(doc, ranges);
  return {
    ai: buckets.ai.size,
    human: buckets.human.size,
    external: buckets.external.size,
    total: buckets.ai.size + buckets.human.size + buckets.external.size,
  };
}

export async function collectWorkspaceRollup(options: CollectRollupOptions): Promise<WorkspaceRollup> {
  const { engine, persistence, folders, isTracked, getDocument } = options;
  const files: FileRollup[] = [];
  const seen = new Set<string>();

  for (const folder of folders) {
    const liveDocIds = engine.listTrackedDocIds().filter((docId) => withinFolder(docId, folder.path));
    for (const docId of liveDocIds) {
      if (isTracked && !isTracked(docId)) continue;
      if (seen.has(docId)) continue;
      seen.add(docId);
      files.push({ docId, stats: statsFor(engine.getRanges(docId), getDocument?.(docId)) });
    }

    const persisted = await persistence.listPersisted(folder.key);
    for (const entry of persisted) {
      if (!withinFolder(entry.docId, folder.path)) continue;
      if (isTracked && !isTracked(entry.docId)) continue;
      if (seen.has(entry.docId)) continue; // live engine state already wins
      seen.add(entry.docId);
      // Already 1-unit-per-line -- no conversion needed.
      files.push({ docId: entry.docId, stats: computeStats(entry.ranges) });
    }
  }

  const total = files.reduce((acc, f) => addStats(acc, f.stats), EMPTY_STATS);
  return { files, total };
}

function withinFolder(docId: string, folderPath: string): boolean {
  return docId === folderPath || docId.startsWith(folderPath.endsWith("/") ? folderPath : `${folderPath}/`);
}
