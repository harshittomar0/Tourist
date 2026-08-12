/**
 * Line-based diff used by the whole-file-diff ingestion path (Phase 1's
 * "second ingestion mechanism" for tracked-but-closed files). Produces
 * aligned "hunks" -- maximal runs of non-matching lines on both sides -- via
 * a longest-common-subsequence alignment, same family of algorithm as
 * tourist-raw's hooks/tourist-hook.mjs `changedLines()`, but returning full
 * old-side *and* new-side spans (tourist-raw's version only ever needed the
 * new-side changed indices; the whole-file-diff path needs both, to compute
 * a `RangeEdit` -- rangeOffset/rangeLength/textLength -- per hunk).
 */

export interface Hunk {
  /** Half-open line-index range in the old content. */
  oldStart: number;
  oldEnd: number;
  /** Half-open line-index range in the new content. */
  newStart: number;
  newEnd: number;
}

// Same pathological-size guard as tourist-hook.mjs's changedLines(), ported
// verbatim rather than re-derived.
const LCS_CELL_CAP = 4_000_000;

/**
 * Aligns `oldLines`/`newLines` and returns the gaps between matched lines as
 * hunks. Lines that align 1:1 with an identical line on the other side are
 * treated as unchanged and never appear in a hunk.
 */
export function computeLineDiffHunks(oldLines: string[], newLines: string[]): Hunk[] {
  const m = oldLines.length;
  const n = newLines.length;

  if (m === 0 && n === 0) return [];
  if (m === 0) return [{ oldStart: 0, oldEnd: 0, newStart: 0, newEnd: n }];
  if (n === 0) return [{ oldStart: 0, oldEnd: m, newStart: 0, newEnd: 0 }];

  if (m * n > LCS_CELL_CAP) {
    // Pathologically large file pair: fall back to "whole file replaced"
    // rather than a cheaper heuristic alignment. Conservative (coarser
    // attribution granularity for this one diff) but never incorrect --
    // mirrors the guard in hooks/attribution-hook.mjs's own fallback branch.
    return [{ oldStart: 0, oldEnd: m, newStart: 0, newEnd: n }];
  }

  const dp: Int32Array[] = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const matches: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      matches.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }

  const hunks: Hunk[] = [];
  let oldCursor = 0;
  let newCursor = 0;
  for (const [mi, mj] of matches) {
    if (mi > oldCursor || mj > newCursor) {
      hunks.push({ oldStart: oldCursor, oldEnd: mi, newStart: newCursor, newEnd: mj });
    }
    oldCursor = mi + 1;
    newCursor = mj + 1;
  }
  if (oldCursor < m || newCursor < n) {
    hunks.push({ oldStart: oldCursor, oldEnd: m, newStart: newCursor, newEnd: n });
  }
  return hunks;
}

/**
 * Char offset (UTF-16 code units) where each line of `content` starts, plus
 * a trailing sentinel equal to `content.length` at index `lines.length` --
 * so `offsets[hunk.oldEnd]` is always valid, including when `oldEnd` is the
 * one-past-the-end index produced by computeLineDiffHunks.
 */
export function lineStartOffsets(content: string): number[] {
  const lines = content.length ? content.split("\n") : [];
  const offsets: number[] = new Array(lines.length + 1);
  let cursor = 0;
  for (let idx = 0; idx < lines.length; idx++) {
    offsets[idx] = cursor;
    cursor += lines[idx].length + 1; // +1 for the '\n' separator
  }
  offsets[lines.length] = content.length;
  return offsets;
}
