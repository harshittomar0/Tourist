/**
 * Contract types for the persistence layer.
 *
 * `AttributedRange` mirrors what src/core/ is expected to produce. Agent A owns the
 * real definition; this is Agent B's best-guess mirror so persistence can be built
 * and unit-tested independently, per the hand-written-fixture requirement. Any
 * mismatch with the real core type must be reconciled when core lands (see
 * STATUS_REPORT.md "contract mismatches").
 */

export type AttributionTier = "verified" | "inferred" | "heuristic";

export interface AttributionInfo {
  author: string;
  tier: AttributionTier;
  createdAt: number;
  updatedAt: number;
  note?: string;
}

export interface RangeSpan {
  startLine: number;
  endLine: number;
}

/** What Agent A's engine is assumed to hand us for a single attributed span. */
export interface AttributedRange {
  id: string;
  /** fsPath at the moment the engine observed it — NOT a stable key, may be stale after renames. */
  fsPath: string;
  range: RangeSpan;
  /** Exact text of the span, used to derive the content-hash anchor. */
  text: string;
  attribution: AttributionInfo;
}

/** A persisted entry, anchored by content hash rather than fsPath. */
export interface PersistedEntry {
  id: string;
  contentHash: string;
  /** Best-known fsPath for display purposes only — never used as the lookup key. */
  lastSeenFsPath: string;
  range: RangeSpan;
  attribution: AttributionInfo;
}

export interface RepoBranchKey {
  repoRoot: string;
  branch: string;
}

export interface PersistedStore {
  version: 1;
  repoRoot: string;
  branch: string;
  entries: PersistedEntry[];
}
