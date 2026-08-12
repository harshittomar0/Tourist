/**
 * Stand-in copies of the cross-agent contract shapes from PLAN1.md Part 2
 * ("Interfaces / contracts"). Agent C (this module's owner) builds against
 * these rather than importing Agent A's `src/core/` or Agent B's
 * `src/persistence/` directly, per the module-ownership rule that no two
 * agents write into -- or depend at build time on the concrete files of --
 * another agent's directory while work is still parallelized.
 *
 * At Sync point 1/2 (mock-to-real swap), this file is deleted and every
 * import of it is repointed at Agent A's `src/core/index.ts` (which already
 * exports `AttributedRange`, `NormalizedChangeBatch`, etc. verbatim -- see
 * the final report) and Agent B's real persistence module. Every consumer in
 * this directory imports the shapes *from this file*, never inline, so that
 * swap is a one-line import change per file, not a rewrite.
 */

// -- Contract §2 (AttributedRange) + §1 (NormalizedChange*) --------------
// Verified byte-for-byte against Agent A's actual src/core/types.ts.

export type Origin = "ai" | "human" | "external" | null;
export type Tier = "1" | "2a" | "2b" | "2c" | "3" | "4";

export interface AttributedRange {
  startOffset: number;
  endOffset: number;
  origin: Origin;
  tier: Tier | null;
  timestamp: number;
}

export interface NormalizedChange {
  rangeOffset: number;
  rangeLength: number;
  text: string;
}

export type ChangeReason = "typed" | "undo" | "redo";

export interface NormalizedChangeBatch {
  docId: string;
  changes: NormalizedChange[];
  dirtyBefore: boolean;
  dirtyAfter: boolean;
  reason: ChangeReason;
  timestamp?: number;
}

export interface WholeFileDiffInput {
  docId: string;
  newContent: string;
  timestamp: number;
  previousContent?: string;
}

export interface Disposable {
  dispose(): void;
}

// -- Contract §2 (engine surface) -----------------------------------------
//
// "The engine exposes: a way to push a NormalizedChange batch for a document
// identity in; a way to read the current AttributedRange[] for a document
// identity; a subscribable event that fires whenever a document's ranges
// change [...]. It also exposes document lifecycle entry points (open --
// optionally seeded with a restored AttributedRange[] [...] -- close, save)."
//
// `setGitOpSuppression` is NOT literal contract text -- flagged in the final
// report as a gap the contract doc doesn't mention at all, even though Phase
// 4's own exit criteria require *some* mechanism for it. Included here
// because Agent A's real engine.ts independently arrived at the exact same
// method name/signature while implementing Phase 1 (cross-checked directly
// against src/core/engine.ts), which is a good sign the two sides converged
// on the same shape rather than a coincidence to paper over.
export interface EngineLike {
  open(docId: string, initialContent: string, restore?: AttributedRange[]): AttributedRange[];
  close(docId: string): void;
  save(docId: string): void;
  pushChanges(batch: NormalizedChangeBatch): AttributedRange[];
  getRanges(docId: string): AttributedRange[];
  onDidChangeRanges(listener: (docId: string) => void): Disposable;
  ingestWholeFileDiff(input: WholeFileDiffInput): AttributedRange[];
  setGitOpSuppression(workspaceId: string, suppressed: boolean): void;
  /**
   * NOT in the literal Part 2 contract text at all -- a real gap flagged in
   * the final report. The status-bar rollup and the new workspace-level
   * view (Phase 3) both need to aggregate `AttributedRange[]` across every
   * *tracked* document, including ones never opened this session -- but
   * §2's engine surface is entirely per-docId (open/getRanges/pushChanges
   * take one docId at a time), with no enumeration method. Since Agent A's
   * real engine already keeps every ingested document's state in an
   * internal map (per the whole-file-diff path covering every tracked
   * file), exposing that map's keys is a small, natural addition -- but it
   * is an addition, not something Sync point 1's "should be a non-event if
   * the contract held" already covers. Agent A needs to add the equivalent
   * of this method to the real engine before Agent C's workspace-view can
   * swap off the mock.
   */
  listTrackedDocIds(): string[];
}

// -- Contract §1c (tracking-scope / exclusion predicate) ------------------
export interface ExclusionPredicate {
  isTracked(absolutePath: string): boolean;
}

// -- Contract §4 (persistence API) -----------------------------------------
//
// "Load: given a document identity's content-hash and its resolved
// (repoRoot, branch) key, return a previously persisted AttributedRange[] if
// the content hash matches, else nothing." Read literally this omits the
// document's own path/identity from the *load* key -- but two different
// files on the same branch with coincidentally identical content plainly
// must not collide, so `docId` is included as an explicit key component
// here (matching tourist-raw's actual persisted[branch][filePath] shape).
// Flagged in the final report as a contract-text gap, not a real design
// question.
export interface RepoBranchKey {
  repoRoot: string;
  branch: string;
}

export interface PersistenceLike {
  load(docId: string, contentHash: string, key: RepoBranchKey): Promise<AttributedRange[] | undefined>;
  save(docId: string, contentHash: string, key: RepoBranchKey, ranges: AttributedRange[]): Promise<void>;
  /**
   * "given a document identity (its vscode.Uri, which only Agent C's side of
   * the boundary ever touches)" -- this is the one PersistenceLike method
   * that takes a real vscode.Uri rather than a plain docId string, by
   * contract design.
   */
  resolveKey(uri: VscodeUriLike): Promise<RepoBranchKey>;
  rename(oldDocId: string, newDocId: string): Promise<void>;
  /**
   * NOT in the literal Part 2 contract text -- the same enumeration gap as
   * `EngineLike.listTrackedDocIds`, on the persistence side: a tracked file
   * that was attributed in a *past* session and hasn't been touched since
   * this activation lives only in Agent B's store, never entering Agent
   * A's in-memory engine at all (lazy snapshot seeding, per Phase 4's
   * large-repo performance row, means the engine does not eagerly load
   * every tracked file at startup). The workspace-level view needs
   * *someone's* enumeration to include that file; §4 as written only
   * supports "load this one already-known docId," not "list everything
   * persisted for this (repoRoot, branch)." Flagged for Agent B to confirm
   * or provide an equivalent before the real swap.
   */
  listPersisted(key: RepoBranchKey): Promise<Array<{ docId: string; ranges: AttributedRange[] }>>;

  // -- Git-notes API (Mode B only; no-ops when tourist.shareAttribution is
  // off -- Agent C's settings UI only flips that setting and never branches
  // on mode, per contract §4's "Mode toggle" paragraph).
  writeNote(commitSha: string, payload: AttributionNotePayload): Promise<void>;
  readNote(commitSha: string): Promise<AttributionNotePayload | undefined>;
  pushNotes(remote: string): Promise<void>;
  fetchNotes(remote: string): Promise<void>;
}

/**
 * Structured git-notes payload shape. Not spelled out field-by-field
 * anywhere in PLAN1.md ("a structured attribution payload") -- this is
 * Agent C's own placeholder shape for mock purposes only, flagged in the
 * final report since Agent B owns the real shape and may finalize it
 * differently once Phase 0 experiment 7 lands.
 */
export interface AttributionNotePayload {
  commitSha: string;
  ranges: AttributedRange[];
  recordedAt: number;
}

/**
 * Minimal structural subset of `vscode.Uri` this module actually needs, so
 * `contracts.ts` itself stays free of a real `import * as vscode` -- keeping
 * this file mockable/testable without the `vscode` module being resolvable
 * (e.g. under plain `vitest`, outside the extension host).
 */
export interface VscodeUriLike {
  readonly fsPath: string;
  toString(): string;
}
