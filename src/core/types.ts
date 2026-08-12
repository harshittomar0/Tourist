/**
 * Shared shapes for the core detection engine (Agent A's src/core/). This
 * file has zero dependencies on `vscode` -- per PLAN1.md Part 2, nothing in
 * src/core/ may import the real editor module except behind clearly
 * injectable interfaces (there are none here; these are plain data shapes).
 */

export interface Disposable {
  dispose(): void;
}

/**
 * Contract §2 (AttributedRange.origin). Three real classification buckets
 * plus `null` for unmarked/committed-baseline content that nothing has
 * touched yet, mirroring tourist-raw's existing three-state-plus-null model.
 */
export type Origin = "ai" | "human" | "external" | null;

/**
 * Contract §2 (AttributedRange.tier): the confidence provenance for *why* a
 * range was classified a given way.
 *
 * Deviation from the literal contract text, flagged here and in the final
 * report: the contract lists exactly six non-null tier values ("1"/"2a"/
 * "2b"/"2c"/"3"/"4") as if every AttributedRange carries one. In practice
 * only disk-write-inferred ranges (origin "ai" via 1/2a/2b/2c, or "external"
 * via 3) go through the tier ladder at all -- a `origin: "human"` range
 * comes directly from the dirty-before/after check, which sits *upstream* of
 * the tier ladder, not inside it, and an unmarked/committed-baseline range
 * (`origin: null`) was never classified by anything. Forcing one of the six
 * literal tier values onto those two cases would misrepresent them (e.g.
 * tagging a human edit tier "3" would conflate it with a genuine
 * external/unknown disk write, defeating the point of Tier 3 being a
 * distinct bucket). `tier` is therefore nullable here; it is one of the six
 * contract values exactly when `origin` is "ai" or "external", and `null`
 * whenever `origin` is "human" or `null`.
 */
export type Tier = "1" | "2a" | "2b" | "2c" | "3" | "4";

/** Contract §2 -- the core engine's output shape. */
export interface AttributedRange {
  startOffset: number;
  endOffset: number;
  origin: Origin;
  tier: Tier | null;
  timestamp: number;
}

/** Contract §1 -- one raw content-change entry within a document event. */
export interface NormalizedChange {
  /** UTF-16 code unit offset into the pre-edit content. */
  rangeOffset: number;
  /** Length, in UTF-16 code units, of the replaced span. */
  rangeLength: number;
  /** The replacement text. */
  text: string;
}

export type ChangeReason = "typed" | "undo" | "redo";

/**
 * Contract §1 -- what Agent C's document-change listener calls into the
 * engine with. `docId` is a stable string key (never a raw `vscode.Uri`), so
 * the core stays vscode-free per the ownership rules.
 */
export interface NormalizedChangeBatch {
  docId: string;
  changes: NormalizedChange[];
  dirtyBefore: boolean;
  dirtyAfter: boolean;
  reason: ChangeReason;
  /** Defaults to Date.now() when omitted -- explicit here so fixture-driven
   * unit tests stay deterministic. */
  timestamp?: number;
}

/**
 * Contract §1b -- whole-file-diff ingestion input (internal to Agent A: fed
 * by Agent A's own workspace-watcher adapter into Agent A's own engine, for
 * tracked files with no open document).
 *
 * Deviation from the literal contract text: `previousContent` is optional
 * here rather than required. The contract describes it as "the previous
 * baseline content ... resolved from either an in-session snapshot or Agent
 * B's persisted history" -- implying the *caller* resolves it. Making it
 * required would force the workspace-watcher adapter to reach into Agent B's
 * persistence module directly, which cuts against the plan's own
 * no-cross-agent-coupling design (Agent A must not depend on Agent B).
 * Instead, when omitted, the engine resolves a baseline itself: in-session
 * state for `docId` if this session has already seen it, else the injected
 * `SnapshotStore`'s (lazily-seeded) baseline, else "" (treated as a brand
 * new file, matching the hook script's own "m === 0 -> all lines added"
 * convention). Agent C's extension.ts is what wires the SnapshotStore's seed
 * callback to Agent B's persisted history at integration time -- see
 * src/core/snapshot-store.ts.
 */
export interface WholeFileDiffInput {
  docId: string;
  newContent: string;
  timestamp: number;
  previousContent?: string;
}
