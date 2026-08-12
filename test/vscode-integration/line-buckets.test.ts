import { describe, expect, it } from "vitest";
import type { AttributedRange } from "../../src/vscode-integration/contracts.ts";
import { computeLineBuckets, type OffsetToLine } from "../../src/vscode-integration/line-buckets.ts";

/** Fake document: N lines, each `lineLength` chars + a trailing "\n". */
function fakeDoc(lineLength: number): OffsetToLine {
  return {
    positionAt(offset: number) {
      return { line: Math.floor(offset / (lineLength + 1)) };
    },
  };
}

function range(origin: AttributedRange["origin"], start: number, end: number): AttributedRange {
  return { startOffset: start, endOffset: end, origin, tier: null, timestamp: 0 };
}

describe("computeLineBuckets", () => {
  const doc = fakeDoc(4); // lines are "aaaa\n" = 5 chars each

  it("assigns a single-line range to exactly one line", () => {
    const buckets = computeLineBuckets(doc, [range("ai", 0, 4)]);
    expect(buckets.ai).toEqual(new Set([0]));
    expect(buckets.human.size).toBe(0);
    expect(buckets.external.size).toBe(0);
  });

  it("spans a range across multiple lines", () => {
    const buckets = computeLineBuckets(doc, [range("human", 3, 13)]); // line 0 -> line 2
    expect(buckets.human).toEqual(new Set([0, 1, 2]));
  });

  it("skips null-origin (baseline) ranges entirely", () => {
    const buckets = computeLineBuckets(doc, [range(null, 0, 20)]);
    expect(buckets.ai.size + buckets.human.size + buckets.external.size).toBe(0);
  });

  it("skips zero-length/inverted ranges without throwing", () => {
    const buckets = computeLineBuckets(doc, [range("external", 5, 5), range("external", 8, 3)]);
    expect(buckets.external.size).toBe(0);
  });

  it("puts each origin in its own distinct bucket for adjacent ranges", () => {
    const buckets = computeLineBuckets(doc, [range("ai", 0, 4), range("human", 5, 9), range("external", 10, 14)]);
    expect(buckets.ai).toEqual(new Set([0]));
    expect(buckets.human).toEqual(new Set([1]));
    expect(buckets.external).toEqual(new Set([2]));
  });
});
