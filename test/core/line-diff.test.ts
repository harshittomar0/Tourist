import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { computeLineDiffHunks, lineStartOffsets } from "../../src/core/line-diff.ts";

describe("computeLineDiffHunks", () => {
  test("identical content produces no hunks", () => {
    assert.deepEqual(computeLineDiffHunks(["a", "b", "c"], ["a", "b", "c"]), []);
  });

  test("a single changed line in the middle produces one hunk", () => {
    const hunks = computeLineDiffHunks(["a", "b", "c"], ["a", "X", "c"]);
    assert.deepEqual(hunks, [{ oldStart: 1, oldEnd: 2, newStart: 1, newEnd: 2 }]);
  });

  test("an appended line at the end produces a pure-insert hunk", () => {
    const hunks = computeLineDiffHunks(["a", "b"], ["a", "b", "c"]);
    assert.deepEqual(hunks, [{ oldStart: 2, oldEnd: 2, newStart: 2, newEnd: 3 }]);
  });

  test("a deleted line produces a pure-delete hunk", () => {
    const hunks = computeLineDiffHunks(["a", "b", "c"], ["a", "c"]);
    assert.deepEqual(hunks, [{ oldStart: 1, oldEnd: 2, newStart: 1, newEnd: 1 }]);
  });

  test("brand-new file (empty old content) is one hunk covering everything", () => {
    assert.deepEqual(computeLineDiffHunks([], ["a", "b"]), [{ oldStart: 0, oldEnd: 0, newStart: 0, newEnd: 2 }]);
  });

  test("fully deleted file (empty new content) is one hunk covering everything", () => {
    assert.deepEqual(computeLineDiffHunks(["a", "b"], []), [{ oldStart: 0, oldEnd: 2, newStart: 0, newEnd: 0 }]);
  });

  test("two disjoint changed regions produce two hunks", () => {
    const hunks = computeLineDiffHunks(["a", "b", "c", "d", "e"], ["X", "b", "c", "Y", "e"]);
    assert.deepEqual(hunks, [
      { oldStart: 0, oldEnd: 1, newStart: 0, newEnd: 1 },
      { oldStart: 3, oldEnd: 4, newStart: 3, newEnd: 4 },
    ]);
  });
});

describe("lineStartOffsets", () => {
  test("computes per-line start offsets plus a trailing content-length sentinel", () => {
    const content = "ab\ncde\nf";
    // lines: "ab" (0), "cde" (3), "f" (7); content.length = 8
    assert.deepEqual(lineStartOffsets(content), [0, 3, 7, 8]);
  });

  test("empty content", () => {
    assert.deepEqual(lineStartOffsets(""), [0]);
  });
});
