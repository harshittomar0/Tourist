import { PieceTable, type RangeEdit } from "./piece-table.ts";
import { computeLineDiffHunks, lineStartOffsets } from "./line-diff.ts";
import { classifyLiveChange, classifyWholeFileDiffSpan } from "./tier-classifier.ts";
import { hashContent } from "./hash.ts";
import { createSnapshotStore, type SnapshotStore } from "./snapshot-store.ts";
import { CorroborationStore } from "./corroboration-store.ts";
import type { HookLogReaderAdapter } from "./adapter-interfaces.ts";
import type {
  AttributedRange,
  Disposable,
  NormalizedChange,
  NormalizedChangeBatch,
  Origin,
  Tier,
  WholeFileDiffInput,
} from "./types.ts";

// How many past content states to remember per document, for restoring
// attribution across undo/redo. Bounded so a long editing session can't grow
// memory without limit -- ported from tourist-raw's tracker.ts.
const MAX_HISTORY_PER_DOC = 50;

/**
 * Grace window `setGitOpSuppression(true)` retroactively reclassifies over
 * (see below). `spike/FINDINGS.md` Experiment 6's live measurements of
 * `vscode.git`'s `repository.state.onDidChange` -- `checkout -b` observed
 * in 1.19s, `checkout main` in 3.29s, "both...reliably under ~4s" -- are the
 * basis for this: that event (the extension.ts wiring's only signal to call
 * `setGitOpSuppression`) can lag the actual git command by several seconds,
 * long enough for Tourist's own disk watchers to classify the resulting
 * write as "ai"/"external" *before* suppression turns on. 4s covers the
 * spike's observed worst case with margin.
 */
const GIT_OP_RETROACTIVE_WINDOW_MS = 4000;

interface DocState {
  pieceTable: PieceTable;
  /** Mirror of the document's current full text. Maintained independently
   * of any real vscode.TextDocument (the engine is vscode-free) so the
   * engine can compute content hashes for undo/redo history and Tier-1
   * hook-log cross-checks by itself. See the final report: the contract's
   * NormalizedChangeBatch shape has no resulting-content-hash field, so
   * this mirror is how the engine stays self-sufficient without asking
   * Agent C to also thread full document text through the contract. */
  content: string;
  history: Map<string, AttributedRange[]>;
}

export interface EngineDeps {
  corroborationStore: CorroborationStore;
  /** Maps a document identity to the workspace identity used to key the
   * corroboration store. Defaults to the identity function (docId itself)
   * if omitted -- a reasonable fallback when docId already *is* a
   * workspace-scoped key, but real wiring (Agent C's extension.ts) should
   * normally supply a real resolver once workspace identity is settled. */
  resolveWorkspaceId?: (docId: string) => string;
  /** Maps a document identity to its absolute filesystem path, for Tier-1
   * hook-log lookups. Defaults to the identity function. */
  resolveAbsolutePath?: (docId: string) => string;
  hookLogReader?: HookLogReaderAdapter;
  snapshotStore?: SnapshotStore;
}

function identity(docId: string): string {
  return docId;
}

/**
 * The core, vscode-independent detection engine (Phase 1). Consumes
 * `NormalizedChange` batches from the live-editing path (Agent C's
 * document-change listener) and `WholeFileDiffInput`s from the
 * whole-file-diff path (Agent A's own workspace-watcher adapter, for
 * tracked files with no open document) and produces `AttributedRange[]`
 * from a single shared per-document `PieceTable` -- one engine, two
 * ingestion mechanisms, per the Phase 1 design constraint.
 */
export class AttributionEngine {
  private readonly docs = new Map<string, DocState>();
  private readonly suppressedWorkspaces = new Set<string>();
  private readonly listeners = new Set<(docId: string) => void>();
  private readonly snapshotStore: SnapshotStore;

  constructor(private readonly deps: EngineDeps) {
    this.snapshotStore = deps.snapshotStore ?? createSnapshotStore();
  }

  // -- Lifecycle -------------------------------------------------------

  /** Opens a document, optionally restoring a previously-persisted
   * `AttributedRange[]` snapshot (Agent B's load-on-open API). Mirrors
   * tourist-raw's `onOpen`. A no-op if the document is already open. */
  open(docId: string, initialContent: string, restore?: AttributedRange[]): AttributedRange[] {
    if (this.docs.has(docId)) return this.docs.get(docId)!.pieceTable.toRanges();

    const pieceTable =
      restore && rangesSpanLength(restore) === initialContent.length
        ? PieceTable.fromRanges(restore)
        : new PieceTable(initialContent.length, null, null, Date.now());

    const state: DocState = { pieceTable, content: initialContent, history: new Map() };
    this.docs.set(docId, state);
    this.rememberHistory(state, hashContent(initialContent));
    this.snapshotStore.setBaseline(docId, initialContent);
    return pieceTable.toRanges();
  }

  close(docId: string): void {
    this.docs.delete(docId);
  }

  /** No attribution effect by itself (dirty-state transition is inferred
   * from the next change event's `dirtyBefore`), kept for symmetry with
   * tourist-raw's onOpen/onClose/onSave lifecycle and as an explicit place
   * for Agent C to notify the engine a save occurred. */
  save(_docId: string): void {
    // Intentionally a no-op: this engine derives "clean" state entirely
    // from dirtyBefore/dirtyAfter on each NormalizedChangeBatch rather than
    // tracking a persistent dirty flag itself, so there is nothing to
    // update here. Kept as a real method (not omitted) so the lifecycle
    // shape matches the contract and callers don't need a conditional.
  }

  // -- Live-editing ingestion path --------------------------------------

  pushChanges(batch: NormalizedChangeBatch): AttributedRange[] {
    const state = this.ensureDoc(batch.docId);
    const timestamp = batch.timestamp ?? Date.now();

    if (batch.reason === "undo" || batch.reason === "redo") {
      this.applyRawEdits(state, batch.changes, null, null, timestamp);
      const hash = hashContent(state.content);
      const remembered = state.history.get(hash);
      if (remembered && rangesSpanLength(remembered) === state.content.length) {
        // Landed back on a content state we've seen -- restore its tags
        // exactly, instead of leaving the touched region unmarked.
        state.pieceTable = PieceTable.fromRanges(remembered);
      }
      this.rememberHistory(state, hash);
      this.snapshotStore.setBaseline(batch.docId, state.content);
      this.notify(batch.docId);
      return state.pieceTable.toRanges();
    }

    const workspaceId = (this.deps.resolveWorkspaceId ?? identity)(batch.docId);
    const absolutePath = (this.deps.resolveAbsolutePath ?? identity)(batch.docId);
    const suppressed = this.suppressedWorkspaces.has(workspaceId);

    // Hook-match is checked against the *prospective* resulting content --
    // computed without mutating engine state yet -- because dirtyBefore/
    // dirtyAfter both false means this event can only be VS Code silently
    // reloading a disk write, so the reconstructed content must be exactly
    // what the hook already hashed when Claude Code wrote it (barring a
    // hash collision). See adapter-interfaces.ts's `matchesContent` doc.
    const wouldBeDiskWrite = !batch.dirtyBefore && !batch.dirtyAfter;
    let hookMatch = false;
    if (wouldBeDiskWrite && this.deps.hookLogReader) {
      const prospectiveContent = spliceText(state.content, batch.changes);
      hookMatch = this.deps.hookLogReader.matchesContent(absolutePath, hashContent(prospectiveContent));
    }

    const { origin, tier } = classifyLiveChange({
      dirtyBefore: batch.dirtyBefore,
      dirtyAfter: batch.dirtyAfter,
      hookMatch,
      corroboration: this.deps.corroborationStore.getSnapshot(workspaceId),
      suppressed,
    });

    this.applyRawEdits(state, batch.changes, origin, tier, timestamp);
    this.rememberHistory(state, hashContent(state.content));
    this.snapshotStore.setBaseline(batch.docId, state.content);
    this.notify(batch.docId);
    return state.pieceTable.toRanges();
  }

  getRanges(docId: string): AttributedRange[] {
    return this.docs.get(docId)?.pieceTable.toRanges() ?? [];
  }

  onDidChangeRanges(listener: (docId: string) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  // -- Whole-file-diff ingestion path (contract §1b) --------------------

  /**
   * Fed by Agent A's own workspace-watcher adapter for a tracked file with
   * no open document. Computes a line-level diff between the resolved
   * baseline and `input.newContent`, classifies each changed hunk through
   * the *same* tier ladder as the live path (skipping the dirty-before/
   * after check entirely -- meaningless for a closed file), and applies the
   * result through the *same* `PieceTable.applyBatch` the live path uses,
   * so this is a second ingestion mechanism into one engine, not a
   * parallel system, per the Phase 1 design constraint.
   */
  ingestWholeFileDiff(input: WholeFileDiffInput): AttributedRange[] {
    const existing = this.docs.get(input.docId);
    const previousContent =
      input.previousContent ?? existing?.content ?? this.snapshotStore.getBaseline(input.docId) ?? "";

    let state = existing;
    if (!state) {
      state = {
        pieceTable: new PieceTable(previousContent.length, null, null, input.timestamp),
        content: previousContent,
        history: new Map(),
      };
      this.docs.set(input.docId, state);
    }

    const workspaceId = (this.deps.resolveWorkspaceId ?? identity)(input.docId);
    const absolutePath = (this.deps.resolveAbsolutePath ?? identity)(input.docId);
    const suppressed = this.suppressedWorkspaces.has(workspaceId);
    const corroboration = this.deps.corroborationStore.getSnapshot(workspaceId);

    const oldLines = previousContent.length ? previousContent.split("\n") : [];
    const newLines = input.newContent.length ? input.newContent.split("\n") : [];
    const hunks = computeLineDiffHunks(oldLines, newLines);
    const oldOffsets = lineStartOffsets(previousContent);
    const newOffsets = lineStartOffsets(input.newContent);
    const newContentHash = hashContent(input.newContent);

    const edits: RangeEdit[] = hunks.map((hunk) => {
      const hookMatch =
        this.deps.hookLogReader?.matchesSpan(absolutePath, newContentHash, hunk.newStart, hunk.newEnd) ?? false;
      const { origin, tier } = classifyWholeFileDiffSpan({ hookMatch, corroboration, suppressed });
      return {
        rangeOffset: oldOffsets[hunk.oldStart],
        rangeLength: oldOffsets[hunk.oldEnd] - oldOffsets[hunk.oldStart],
        textLength: newOffsets[hunk.newEnd] - newOffsets[hunk.newStart],
        origin,
        tier,
        timestamp: input.timestamp,
      };
    });

    state.pieceTable.applyBatch(edits);
    state.content = input.newContent;
    this.rememberHistory(state, newContentHash);
    this.snapshotStore.setBaseline(input.docId, input.newContent);
    this.notify(input.docId);
    return state.pieceTable.toRanges();
  }

  // -- Git-op suppression (addition beyond the literal contract) --------

  /**
   * Not part of the literal Part 2 contract text -- added because Phase 4's
   * own exit criteria ("a git checkout/pull/rebase/stash... is left
   * unmarked/reconciled against branch history, not tagged ai or
   * external") requires *some* mechanism for whoever detects a git
   * operation (Agent B's branch-change listener, or Agent C's wiring of it)
   * to tell this engine "suppress disk-write classification right now",
   * and neither `NormalizedChange` nor the engine lifecycle entry points in
   * the contract expose one. See the final report.
   */
  setGitOpSuppression(workspaceId: string, suppressed: boolean): void {
    if (suppressed) {
      this.suppressedWorkspaces.add(workspaceId);
      this.reclassifyRecentDiskWrites(workspaceId, Date.now());
    } else {
      this.suppressedWorkspaces.delete(workspaceId);
    }
  }

  /**
   * The other half of the grace window documented at
   * `GIT_OP_RETROACTIVE_WINDOW_MS`: corrects anything in this workspace's
   * open/tracked docs that a disk-write heuristic tagged "ai"/"external" in
   * the last `GIT_OP_RETROACTIVE_WINDOW_MS`ms, now that we know it was
   * actually a git op. Deliberately excludes tier "1" (a real content-hash
   * match against the attribution hook log) -- that's a confirmed Claude
   * Code write, not a heuristic guess, and coincidentally landing inside a
   * suppression window doesn't make it any less real.
   */
  private reclassifyRecentDiskWrites(workspaceId: string, now: number): void {
    const resolveWorkspaceId = this.deps.resolveWorkspaceId ?? identity;
    const since = now - GIT_OP_RETROACTIVE_WINDOW_MS;
    for (const [docId, state] of this.docs) {
      if (resolveWorkspaceId(docId) !== workspaceId) continue;
      const changed = state.pieceTable.reclassify(
        (piece) =>
          piece.timestamp >= since && (piece.origin === "ai" || piece.origin === "external") && piece.tier !== "1"
      );
      if (!changed) continue;
      this.rememberHistory(state, hashContent(state.content));
      this.notify(docId);
    }
  }

  // -- Enumeration + rename (added post-Phase-1, per PLAN1.md Part 2 §7 -----
  // contract-gap fixes: the workspace-level view needs to enumerate every
  // tracked document, open or closed, and a file rename must re-key this
  // engine's own in-memory state in place rather than being worked around by
  // the caller doing a close+reopen, which would silently drop history for
  // any doc with no restorable snapshot in hand.) --------------------------

  /** Every document identity this engine currently holds state for, tracked
   * or untouched -- backs the workspace-level attribution view/panel. */
  listTrackedDocIds(): string[] {
    return [...this.docs.keys()];
  }

  /** Moves `oldDocId`'s live in-memory state (piece-table ranges, undo/redo
   * history, the internal content mirror, and its snapshot-store baseline)
   * to `newDocId` in place. A no-op if `oldDocId` isn't currently tracked. */
  renameDocument(oldDocId: string, newDocId: string): void {
    const state = this.docs.get(oldDocId);
    if (!state) return;
    this.docs.delete(oldDocId);
    this.docs.set(newDocId, state);
    this.snapshotStore.setBaseline(newDocId, state.content);
  }

  // -- internals ---------------------------------------------------------

  private ensureDoc(docId: string): DocState {
    let state = this.docs.get(docId);
    if (!state) {
      state = { pieceTable: new PieceTable(0), content: "", history: new Map() };
      this.docs.set(docId, state);
    }
    return state;
  }

  private applyRawEdits(
    state: DocState,
    changes: NormalizedChange[],
    origin: Origin,
    tier: Tier | null,
    timestamp: number
  ): void {
    // Resolve structural-only-insert origins against pre-edit state, before
    // any mutation -- ported from tourist-raw's tracker.ts
    // `isStructuralOnlyInsert` handling.
    const edits: RangeEdit[] = changes.map((change) => {
      const isStructuralOnlyInsert = change.rangeLength === 0 && /^[ \t\r\n]*$/.test(change.text);
      const existing = isStructuralOnlyInsert ? state.pieceTable.originAt(change.rangeOffset) : null;
      return {
        rangeOffset: change.rangeOffset,
        rangeLength: change.rangeLength,
        textLength: change.text.length,
        origin: existing ? existing.origin : origin,
        tier: existing ? existing.tier : tier,
        timestamp,
      };
    });

    // Defensive ordering: the mirror text buffer must be spliced in the same
    // right-to-left order PieceTable.applyBatch uses internally, so offsets
    // stay valid regardless of the batch's original order (see
    // piece-table.ts's applyBatch doc comment).
    state.content = spliceText(state.content, changes);
    state.pieceTable.applyBatch(edits);
  }

  private rememberHistory(state: DocState, hash: string): void {
    state.history.delete(hash);
    state.history.set(hash, state.pieceTable.toRanges());
    while (state.history.size > MAX_HISTORY_PER_DOC) {
      const oldest = state.history.keys().next().value;
      if (oldest === undefined) break;
      state.history.delete(oldest);
    }
  }

  private notify(docId: string): void {
    for (const listener of this.listeners) listener(docId);
  }
}

function rangesSpanLength(ranges: readonly AttributedRange[]): number {
  return ranges.length ? ranges[ranges.length - 1].endOffset : 0;
}

/** Applies a batch of NormalizedChanges to a plain string, defensively
 * sorted the same way PieceTable.applyBatch sorts internally, so the
 * mirror buffer and the piece table never disagree on resulting content. */
function spliceText(content: string, changes: readonly NormalizedChange[]): string {
  const sorted = [...changes].sort((a, b) => b.rangeOffset - a.rangeOffset);
  let result = content;
  for (const change of sorted) {
    result = result.slice(0, change.rangeOffset) + change.text + result.slice(change.rangeOffset + change.rangeLength);
  }
  return result;
}
