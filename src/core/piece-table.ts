import type { AttributedRange, Origin, Tier } from "./types.ts";

interface Piece {
  length: number;
  origin: Origin;
  tier: Tier | null;
  timestamp: number;
}

/** One splice operation against the piece table's current content. */
export interface RangeEdit {
  rangeOffset: number;
  rangeLength: number;
  /** Length of the replacement content, in UTF-16 code units. */
  textLength: number;
  origin: Origin;
  tier: Tier | null;
  timestamp: number;
}

function mergeAdjacent(pieces: Piece[]): Piece[] {
  const merged: Piece[] = [];
  for (const piece of pieces) {
    if (piece.length <= 0) continue;
    const last = merged[merged.length - 1];
    if (last && last.origin === piece.origin && last.tier === piece.tier) {
      last.length += piece.length;
      if (piece.timestamp > last.timestamp) last.timestamp = piece.timestamp;
    } else {
      merged.push({ ...piece });
    }
  }
  return merged;
}

/**
 * Position-mapped range structure that remaps attribution through each
 * edit's offset/length/text, replacing tourist-raw's flat
 * `(LineOrigin | null)[]` per-line array (which desyncs from `doc.lineCount`
 * with no self-heal, and whose splice loop assumed bottom-to-top ordering).
 *
 * Content itself is *not* stored here -- only piece lengths and their
 * attribution metadata. The engine (engine.ts) maintains its own mirror text
 * buffer alongside a PieceTable per document, so a PieceTable is exactly as
 * long as the document it shadows at all times.
 */
export class PieceTable {
  private pieces: Piece[];
  private totalLength: number;

  constructor(initialLength: number, origin: Origin = null, tier: Tier | null = null, timestamp: number = Date.now()) {
    this.pieces = initialLength > 0 ? [{ length: initialLength, origin, tier, timestamp }] : [];
    this.totalLength = Math.max(0, initialLength);
  }

  /** Rebuilds a table directly from a previously-emitted `AttributedRange[]`
   * snapshot (e.g. restoring undo/redo history, or a persisted load-on-open
   * snapshot from Agent B). Ranges must be contiguous and gap-free, as any
   * `toRanges()` output already is. */
  static fromRanges(ranges: readonly AttributedRange[]): PieceTable {
    const table = new PieceTable(0);
    table.pieces = ranges
      .filter((r) => r.endOffset > r.startOffset)
      .map((r) => ({ length: r.endOffset - r.startOffset, origin: r.origin, tier: r.tier, timestamp: r.timestamp }));
    table.totalLength = ranges.length ? ranges[ranges.length - 1].endOffset : 0;
    return table;
  }

  get length(): number {
    return this.totalLength;
  }

  /**
   * Applies a batch of edits belonging to one document-change event.
   *
   * Defensively sorts by descending `rangeOffset` before applying, so that
   * out-of-order `TextDocumentContentChangeEvent[]` entries -- VS Code does
   * not guarantee bottom-to-top ordering, per MS #11487/#111548 (RESEARCH1.md
   * §8 item 5 / PLAN1.md Phase 0 experiment 5) -- can never corrupt offsets.
   * Edits within one event are assumed non-overlapping (VS Code's own
   * contract for `contentChanges`); applying strictly right-to-left against
   * the *original* pre-batch offsets keeps every not-yet-applied edit's
   * `rangeOffset` valid regardless of the array's original order, because
   * only edits at higher offsets -- which never shift positions before
   * themselves -- have been applied so far. This is correct whether or not
   * Phase 0 experiment 5 ultimately reconfirms out-of-order arrival still
   * happens on the pinned VS Code version: the sort is cheap insurance
   * either way, per the plan's explicit framing.
   */
  applyBatch(edits: readonly RangeEdit[]): void {
    const sorted = [...edits].sort((a, b) => b.rangeOffset - a.rangeOffset);
    for (const edit of sorted) this.applyOne(edit);
  }

  private applyOne(edit: RangeEdit): void {
    const start = edit.rangeOffset;
    const end = start + edit.rangeLength;
    if (start < 0 || edit.rangeLength < 0 || end > this.totalLength) {
      throw new RangeError(
        `edit [${start}, ${end}) with rangeLength ${edit.rangeLength} out of bounds for document of length ${this.totalLength}`
      );
    }

    const before: Piece[] = [];
    const after: Piece[] = [];
    let cursor = 0;
    for (const piece of this.pieces) {
      const pieceStart = cursor;
      const pieceEnd = cursor + piece.length;
      cursor = pieceEnd;

      if (pieceEnd <= start) {
        before.push(piece);
      } else if (pieceStart >= end) {
        after.push(piece);
      } else {
        // Piece overlaps [start, end) -- keep the slivers outside the edit.
        if (pieceStart < start) before.push({ ...piece, length: start - pieceStart });
        if (pieceEnd > end) after.push({ ...piece, length: pieceEnd - end });
      }
    }

    const inserted: Piece[] =
      edit.textLength > 0
        ? [{ length: edit.textLength, origin: edit.origin, tier: edit.tier, timestamp: edit.timestamp }]
        : [];

    this.pieces = mergeAdjacent([...before, ...inserted, ...after]);
    this.totalLength = this.totalLength - edit.rangeLength + edit.textLength;
  }

  /**
   * The origin/tier of the piece occupying `offset` -- i.e. what a pure
   * insert at that position would be typed "into". Used for structural-
   * only-insert passthrough (engine.ts): a whitespace/newline-only insert
   * (auto-indent, a bare Enter) doesn't add real authored content, so it
   * inherits the touched position's existing attribution rather than being
   * freshly reattributed -- ported from tourist-raw's
   * `isStructuralOnlyInsert` handling in src/attribution/tracker.ts, adapted
   * from line-indexed lookup to offset-indexed lookup.
   */
  originAt(offset: number): { origin: Origin; tier: Tier | null } | null {
    let cursor = 0;
    for (const piece of this.pieces) {
      const pieceEnd = cursor + piece.length;
      if (offset < pieceEnd || (offset === pieceEnd && pieceEnd === this.totalLength)) {
        return { origin: piece.origin, tier: piece.tier };
      }
      cursor = pieceEnd;
    }
    return null;
  }

  /**
   * Retroactively nulls out (origin/tier -> null) every piece for which
   * `predicate` returns true, keeping its length and timestamp untouched.
   * Returns whether anything actually changed.
   *
   * Backs engine.ts's git-op-suppression grace period: `spike/FINDINGS.md`
   * Experiment 6 measured `vscode.git`'s `repository.state.onDidChange`
   * firing 1.2-3.5s *after* the git command that caused it, while Tourist's
   * own disk watchers react far faster -- so a git-caused disk write can be
   * classified "ai"/"external" before suppression turns on. Once it does
   * turn on, the caller uses this to correct anything misclassified during
   * that race window instead of only guarding writes from that point
   * forward.
   */
  reclassify(predicate: (piece: { origin: Origin; tier: Tier | null; timestamp: number }) => boolean): boolean {
    let changed = false;
    const next = this.pieces.map((piece) => {
      if (!predicate(piece)) return piece;
      changed = true;
      return { ...piece, origin: null, tier: null };
    });
    if (changed) this.pieces = mergeAdjacent(next);
    return changed;
  }

  toRanges(): AttributedRange[] {
    const ranges: AttributedRange[] = [];
    let cursor = 0;
    for (const piece of this.pieces) {
      ranges.push({
        startOffset: cursor,
        endOffset: cursor + piece.length,
        origin: piece.origin,
        tier: piece.tier,
        timestamp: piece.timestamp,
      });
      cursor += piece.length;
    }
    return ranges;
  }
}
