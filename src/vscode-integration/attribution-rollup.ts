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
import type { EngineLike, ExclusionPredicate, PersistenceLike, RepoBranchKey } from "./contracts.ts";
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
}

export async function collectWorkspaceRollup(options: CollectRollupOptions): Promise<WorkspaceRollup> {
  const { engine, persistence, folders, isTracked } = options;
  const files: FileRollup[] = [];
  const seen = new Set<string>();

  for (const folder of folders) {
    const liveDocIds = engine.listTrackedDocIds().filter((docId) => withinFolder(docId, folder.path));
    for (const docId of liveDocIds) {
      if (isTracked && !isTracked(docId)) continue;
      if (seen.has(docId)) continue;
      seen.add(docId);
      files.push({ docId, stats: computeStats(engine.getRanges(docId)) });
    }

    const persisted = await persistence.listPersisted(folder.key);
    for (const entry of persisted) {
      if (!withinFolder(entry.docId, folder.path)) continue;
      if (isTracked && !isTracked(entry.docId)) continue;
      if (seen.has(entry.docId)) continue; // live engine state already wins
      seen.add(entry.docId);
      files.push({ docId: entry.docId, stats: computeStats(entry.ranges) });
    }
  }

  const total = files.reduce((acc, f) => addStats(acc, f.stats), EMPTY_STATS);
  return { files, total };
}

function withinFolder(docId: string, folderPath: string): boolean {
  return docId === folderPath || docId.startsWith(folderPath.endsWith("/") ? folderPath : `${folderPath}/`);
}
