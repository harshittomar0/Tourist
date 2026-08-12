/**
 * Extends tourist-raw's `src/attribution/stats.ts` two-bucket
 * (ai/human/total) rollup to three buckets (ai/human/external/total), per
 * PLAN1.md Phase 3 / contract §5. `total` stays `ai + human + external`
 * only -- unmarked (`origin: null`, committed-baseline) content is still
 * deliberately excluded, for the same reason tourist-raw excluded it: the
 * question is "of the code that's been touched since tracking started, who
 * wrote how much," not "how much of the file."
 */
import type { AttributedRange } from "./contracts.ts";

export interface AttributionStats {
  ai: number;
  human: number;
  external: number;
  total: number;
}

export const EMPTY_STATS: AttributionStats = { ai: 0, human: 0, external: 0, total: 0 };

/** Counts by (endOffset - startOffset), i.e. characters, not lines -- the
 * engine's own unit. Callers rendering a *line*-based percentage (e.g. to
 * stay visually consistent with tourist-raw's line-counted stats) should
 * bucket lines themselves first (see decorations.ts's `computeLineBuckets`)
 * and pass in the line count as if it were length 1 per line; kept
 * length-based here since `AttributedRange` has no line concept at all. */
export function computeStats(ranges: readonly AttributedRange[]): AttributionStats {
  let ai = 0;
  let human = 0;
  let external = 0;
  for (const range of ranges) {
    const length = Math.max(0, range.endOffset - range.startOffset);
    if (range.origin === "ai") ai += length;
    else if (range.origin === "human") human += length;
    else if (range.origin === "external") external += length;
  }
  return { ai, human, external, total: ai + human + external };
}

export function addStats(a: AttributionStats, b: AttributionStats): AttributionStats {
  return {
    ai: a.ai + b.ai,
    human: a.human + b.human,
    external: a.external + b.external,
    total: a.total + b.total,
  };
}

export interface StatsPercentages {
  aiPct: number;
  humanPct: number;
  externalPct: number;
}

export function percentagesOf(stats: AttributionStats): StatsPercentages {
  if (stats.total === 0) return { aiPct: 0, humanPct: 0, externalPct: 0 };
  const aiPct = Math.round((stats.ai / stats.total) * 100);
  const humanPct = Math.round((stats.human / stats.total) * 100);
  // externalPct absorbs rounding so the three always sum to exactly 100,
  // rather than each independently rounding and drifting off by 1-2%.
  const externalPct = 100 - aiPct - humanPct;
  return { aiPct, humanPct, externalPct };
}

export function formatStats(stats: AttributionStats): string {
  if (stats.total === 0) return "Tourist: no tracked lines yet";
  const { aiPct, humanPct, externalPct } = percentagesOf(stats);
  return `Tourist: ${aiPct}% AI, ${humanPct}% human, ${externalPct}% external`;
}
