/**
 * Sync point 1/2 (mock-to-real swap), done: this file no longer mirrors
 * Agent A/B's contract shapes by hand -- it re-exports Agent A's real
 * `src/core/index.ts` types verbatim and adds only the UI-side interface
 * shapes (`EngineLike`, `PersistenceLike`) that describe what
 * `src/vscode-integration/` needs from *some* engine/persistence
 * implementation, real or mock, for dependency injection in tests.
 *
 * `EngineLike` now includes `renameDocument`, confirmed to exist for real on
 * Agent A's `AttributionEngine` (src/core/engine.ts) as of this
 * consolidation pass -- the close+reopen rename workaround in extension.ts
 * that this method was meant to replace has been removed accordingly.
 */

export type {
  Origin,
  Tier,
  AttributedRange,
  NormalizedChange,
  ChangeReason,
  NormalizedChangeBatch,
  WholeFileDiffInput,
  Disposable,
} from "../core/index.ts";
import type { AttributedRange, Disposable, NormalizedChangeBatch, WholeFileDiffInput } from "../core/index.ts";

// -- Contract §2 (engine surface) -----------------------------------------
//
// "The engine exposes: a way to push a NormalizedChange batch for a document
// identity in; a way to read the current AttributedRange[] for a document
// identity; a subscribable event that fires whenever a document's ranges
// change [...]. It also exposes document lifecycle entry points (open --
// optionally seeded with a restored AttributedRange[] [...] -- close, save)."
//
// `setGitOpSuppression`, `listTrackedDocIds`, and `renameDocument` are not
// literal Part 2 contract text -- all three were flagged gaps in the
// pre-consolidation handoff, and all three are now confirmed present for
// real on Agent A's `AttributionEngine` (src/core/engine.ts) as of this
// integration pass (listTrackedDocIds and setGitOpSuppression already
// existed; renameDocument was added during consolidation).
export interface EngineLike {
  open(docId: string, initialContent: string, restore?: AttributedRange[]): AttributedRange[];
  close(docId: string): void;
  save(docId: string): void;
  pushChanges(batch: NormalizedChangeBatch): AttributedRange[];
  getRanges(docId: string): AttributedRange[];
  onDidChangeRanges(listener: (docId: string) => void): Disposable;
  ingestWholeFileDiff(input: WholeFileDiffInput): AttributedRange[];
  setGitOpSuppression(workspaceId: string, suppressed: boolean): void;
  /** Every document identity this engine currently holds state for, tracked
   * or untouched -- backs the workspace-level attribution view/panel. */
  listTrackedDocIds(): string[];
  /** Moves a document's live in-memory engine state (ranges, undo/redo
   * history, snapshot baseline) from `oldDocId` to `newDocId` in place.
   * Replaces the close+reopen workaround extension.ts used before this
   * method existed on the real engine. */
  renameDocument(oldDocId: string, newDocId: string): void;
}

// -- Contract §1c (tracking-scope / exclusion predicate) ------------------
export interface ExclusionPredicate {
  isTracked(absolutePath: string): boolean;
}

// -- Contract §4 (persistence API) -----------------------------------------
//
// This interface is the DI seam `extension.ts` programs against -- both
// `MockPersistence` (tests) and `RealPersistenceAdapter`
// (persistence-adapter.ts, wrapping Agent B's real `src/persistence/`)
// implement it.
//
// REAL MISMATCH SURFACED DURING CONSOLIDATION (not papered over -- see the
// integration report): Agent B's real `PersistenceManager` does not expose
// `load`/`save` per-docId at all. It operates on Agent B's own
// `AttributedRange` shape (fsPath + line-range + a `verified`/`inferred`/
// `heuristic` attribution tier), keyed only by `(repoRoot, branch)`, and
// returns/accepts the *entire* `PersistedStore` for that key in one call
// (`load(key)` / `record(key, ranges)`), not a single docId's slice. There
// is no `listPersisted` method either -- grouping the whole-key store by
// `lastSeenFsPath` is exactly that operation, so `persistence-adapter.ts`
// implements it as a thin projection rather than Agent B needing to add
// anything. The deeper mismatch -- Agent A's offset-based piece-table
// `AttributedRange` (this file's re-exported type) vs. Agent B's line-based,
// differently-tiered one -- is real and is reconciled by the adapter via an
// explicit, documented (lossy) conversion; see persistence-adapter.ts's own
// header comment for the exact mapping and its limitations.
export interface RepoBranchKey {
  repoRoot: string;
  branch: string;
}

export interface PersistenceLike {
  /**
   * `currentText` (added during consolidation, beyond the original contract
   * text): the real adapter's per-range content-hash validation and
   * offset<->line conversion both need the document's current full text,
   * not just a single whole-file hash -- see persistence-adapter.ts.
   * `MockPersistence` ignores it; its whole-file-hash gate never needed it.
   */
  load(docId: string, contentHash: string, key: RepoBranchKey, currentText: string): Promise<AttributedRange[] | undefined>;
  save(docId: string, contentHash: string, key: RepoBranchKey, ranges: AttributedRange[], currentText: string): Promise<void>;
  /**
   * "given a document identity (its vscode.Uri, which only Agent C's side of
   * the boundary ever touches)" -- this is the one PersistenceLike method
   * that takes a real vscode.Uri rather than a plain docId string, by
   * contract design.
   */
  resolveKey(uri: VscodeUriLike): Promise<RepoBranchKey>;
  /**
   * `key` (added during consolidation): the real adapter needs the
   * *already-resolved* (repoRoot, branch) to re-key persisted history --
   * re-deriving it from `newDocId`'s filesystem location instead would fail
   * for a rename the caller already has full context for (e.g. moving a
   * file such that `resolveKeyForFile` can't independently re-derive the
   * same answer), and made the method untestable without a real on-disk
   * repo at that path. The caller (extension.ts) already resolves this key
   * for other calls in the same rename handler, so passing it through is
   * free.
   */
  rename(oldDocId: string, newDocId: string, key: RepoBranchKey): Promise<void>;
  listPersisted(key: RepoBranchKey): Promise<Array<{ docId: string; ranges: AttributedRange[] }>>;

  // -- Git-notes API (Mode B only; no-ops when tourist.gitNotesSync is off).
  // `writeNote`/`readNote` are NOT wired to a real commit-time trigger
  // anywhere in this codebase yet (extension.ts never listens for "a commit
  // just happened") -- flagged as a real, unimplemented gap in the
  // integration report rather than fabricated here. `pushNotes`/`fetchNotes`
  // (the two commands PLAN1.md actually specifies for v1) are wired for
  // real, via Agent B's `src/persistence/gitNotes/commands.ts`.
  writeNote(commitSha: string, payload: AttributionNotePayload): Promise<void>;
  readNote(commitSha: string): Promise<AttributionNotePayload | undefined>;
  pushNotes(remote: string): Promise<void>;
  fetchNotes(remote: string): Promise<void>;
}

/**
 * UI-side git-notes payload shape (offset-based, matching this file's
 * `AttributedRange`). `persistence-adapter.ts` converts to/from Agent B's
 * real `AttributionNote`/`AttributionNoteEntry` (line-based) shape at the
 * boundary -- see that file's header comment.
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
