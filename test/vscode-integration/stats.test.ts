import { describe, expect, it } from "vitest";
import type { AttributedRange } from "../../src/vscode-integration/contracts.ts";
import { addStats, computeStats, EMPTY_STATS, formatStats, percentagesOf } from "../../src/vscode-integration/stats.ts";

function range(origin: AttributedRange["origin"], start: number, end: number): AttributedRange {
  return { startOffset: start, endOffset: end, origin, tier: null, timestamp: 0 };
}

describe("computeStats", () => {
  it("buckets by origin and excludes null (baseline) ranges from total", () => {
    const stats = computeStats([range("ai", 0, 10), range("human", 10, 15), range(null, 15, 100), range("external", 100, 103)]);
    expect(stats).toEqual({ ai: 10, human: 5, external: 3, total: 18 });
  });

  it("returns EMPTY_STATS for no ranges", () => {
    expect(computeStats([])).toEqual(EMPTY_STATS);
  });

  it("ignores zero-length or inverted ranges", () => {
    expect(computeStats([range("ai", 5, 5), range("human", 10, 3)])).toEqual(EMPTY_STATS);
  });
});

describe("addStats", () => {
  it("sums every bucket independently", () => {
    const a = { ai: 1, human: 2, external: 3, total: 6 };
    const b = { ai: 4, human: 5, external: 6, total: 15 };
    expect(addStats(a, b)).toEqual({ ai: 5, human: 7, external: 9, total: 21 });
  });
});

describe("percentagesOf", () => {
  it("always sums to exactly 100 despite rounding", () => {
    // 1/3 each would naively round to 33/33/33 = 99 without the
    // external-absorbs-rounding rule.
    const stats = { ai: 1, human: 1, external: 1, total: 3 };
    const pct = percentagesOf(stats);
    expect(pct.aiPct + pct.humanPct + pct.externalPct).toBe(100);
  });

  it("returns all zero percentages for an empty total", () => {
    expect(percentagesOf(EMPTY_STATS)).toEqual({ aiPct: 0, humanPct: 0, externalPct: 0 });
  });
});

describe("formatStats", () => {
  it("reports the no-data message when total is zero", () => {
    expect(formatStats(EMPTY_STATS)).toBe("Tourist: no tracked lines yet");
  });

  it("includes all three percentages", () => {
    const text = formatStats({ ai: 50, human: 30, external: 20, total: 100 });
    expect(text).toBe("Tourist: 50% AI, 30% human, 20% external");
  });
});
