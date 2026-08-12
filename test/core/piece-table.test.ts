import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PieceTable, type RangeEdit } from "../../src/core/piece-table.ts";

function edit(rangeOffset: number, rangeLength: number, textLength: number, origin: "ai" | "human" | "external" | null, tier: RangeEdit["tier"] = null, timestamp = 1): RangeEdit {
  return { rangeOffset, rangeLength, textLength, origin, tier, timestamp };
}

describe("PieceTable", () => {
  test("single insert into an unmarked document produces two ranges", () => {
    const table = new PieceTable(10); // "0123456789", all unmarked
    table.applyBatch([edit(5, 0, 3, "ai", "2a")]); // insert 3 chars at offset 5
    assert.deepEqual(table.toRanges().map((r) => [r.startOffset, r.endOffset, r.origin, r.tier]), [
      [0, 5, null, null],
      [5, 8, "ai", "2a"],
      [8, 13, null, null],
    ]);
    assert.equal(table.length, 13);
  });

  test("replace covering multiple pieces merges correctly", () => {
    const table = new PieceTable(0);
    table.applyBatch([edit(0, 0, 5, "ai", "2a")]); // "aaaaa"
    table.applyBatch([edit(5, 0, 5, "human")]); // "hhhhh"
    // table content length 10: [0,5)=ai, [5,10)=human
    table.applyBatch([edit(3, 4, 2, "external", "3")]); // replace chars [3,7) with 2 external chars
    const ranges = table.toRanges().map((r) => [r.startOffset, r.endOffset, r.origin, r.tier]);
    assert.deepEqual(ranges, [
      [0, 3, "ai", "2a"],
      [3, 5, "external", "3"],
      [5, 8, "human", null],
    ]);
    assert.equal(table.length, 8);
  });

  test("adjacent pieces with identical origin/tier are merged", () => {
    const table = new PieceTable(0);
    table.applyBatch([edit(0, 0, 3, "ai", "2a", 1)]);
    table.applyBatch([edit(3, 0, 3, "ai", "2a", 2)]);
    const ranges = table.toRanges();
    assert.equal(ranges.length, 1);
    assert.deepEqual([ranges[0].startOffset, ranges[0].endOffset], [0, 6]);
    assert.equal(ranges[0].timestamp, 2); // merge keeps the later timestamp
  });

  test("a batch applied out of order produces the same result as sorted order (defensive ordering)", () => {
    // Base document: "0123456789" (10 chars, unmarked). Two independent,
    // non-overlapping inserts in the same event, deliberately given to
    // applyBatch in *ascending* offset order -- exercising the defense
    // against MS #11487/#111548 (contentChanges may not arrive
    // bottom-to-top).
    const ascending = new PieceTable(10);
    ascending.applyBatch([edit(2, 0, 2, "ai", "2a"), edit(7, 0, 2, "human")]);

    const descending = new PieceTable(10);
    descending.applyBatch([edit(7, 0, 2, "human"), edit(2, 0, 2, "ai", "2a")]);

    assert.deepEqual(ascending.toRanges(), descending.toRanges());
    assert.deepEqual(ascending.toRanges().map((r) => [r.startOffset, r.endOffset, r.origin]), [
      [0, 2, null],
      [2, 4, "ai"],
      [4, 9, null],
      [9, 11, "human"],
      [11, 14, null],
    ]);
  });

  test("a randomly-shuffled multi-edit batch is order-independent", () => {
    const edits: RangeEdit[] = [
      edit(20, 0, 1, "ai", "2a"),
      edit(15, 0, 1, "human"),
      edit(10, 0, 1, "external", "3"),
      edit(5, 0, 1, "ai", "1"),
      edit(0, 0, 1, "human"),
    ];
    const base = () => new PieceTable(25);

    const inOrder = base();
    inOrder.applyBatch(edits);

    const shuffled = base();
    shuffled.applyBatch([edits[3], edits[0], edits[4], edits[2], edits[1]]);

    const reversed = base();
    reversed.applyBatch([...edits].reverse());

    assert.deepEqual(inOrder.toRanges(), shuffled.toRanges());
    assert.deepEqual(inOrder.toRanges(), reversed.toRanges());
  });

  test("originAt returns the piece a pure insert at that offset would land in", () => {
    const table = new PieceTable(0);
    table.applyBatch([edit(0, 0, 5, "ai", "2a")]);
    table.applyBatch([edit(5, 0, 5, "human")]);
    assert.deepEqual(table.originAt(0), { origin: "ai", tier: "2a" });
    assert.deepEqual(table.originAt(4), { origin: "ai", tier: "2a" });
    assert.deepEqual(table.originAt(5), { origin: "human", tier: null }); // boundary -> right-hand piece
    assert.deepEqual(table.originAt(9), { origin: "human", tier: null });
    assert.deepEqual(table.originAt(10), { origin: "human", tier: null }); // insert at EOF -> last piece
  });

  test("originAt on an empty table returns null", () => {
    assert.equal(new PieceTable(0).originAt(0), null);
  });

  test("fromRanges / toRanges round-trips", () => {
    const table = new PieceTable(0);
    table.applyBatch([edit(0, 0, 5, "ai", "2a", 1)]);
    table.applyBatch([edit(5, 0, 5, "human", null, 2)]);
    const ranges = table.toRanges();

    const restored = PieceTable.fromRanges(ranges);
    assert.deepEqual(restored.toRanges(), ranges);
    assert.equal(restored.length, table.length);
  });

  test("an edit that goes out of bounds throws rather than corrupting state", () => {
    const table = new PieceTable(5);
    assert.throws(() => table.applyBatch([edit(3, 10, 0, "human")]), RangeError);
  });

  test("a pure deletion removes a piece without leaving a zero-length remnant", () => {
    const table = new PieceTable(0);
    table.applyBatch([edit(0, 0, 5, "ai", "2a")]);
    table.applyBatch([edit(1, 3, 0, "human")]); // delete middle 3 chars, insert nothing
    assert.deepEqual(table.toRanges().map((r) => [r.startOffset, r.endOffset, r.origin]), [[0, 2, "ai"]]);
    assert.equal(table.length, 2);
  });
});
