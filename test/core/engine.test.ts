import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { AttributionEngine } from "../../src/core/engine.ts";
import { CorroborationStore } from "../../src/core/corroboration-store.ts";
import type { NormalizedChangeBatch } from "../../src/core/types.ts";

function insertBatch(docId: string, rangeOffset: number, text: string, opts: Partial<NormalizedChangeBatch> = {}): NormalizedChangeBatch {
  return {
    docId,
    changes: [{ rangeOffset, rangeLength: 0, text }],
    dirtyBefore: true,
    dirtyAfter: true,
    reason: "typed",
    timestamp: 1,
    ...opts,
  };
}

function originsOf(ranges: ReturnType<AttributionEngine["getRanges"]>): Array<[string, string | null]> {
  return ranges.map((r) => [r.origin ?? "null", r.tier ?? "null"] as [string, string | null]);
}

describe("AttributionEngine -- live editing path", () => {
  test("a human keystroke (dirty before and after) is attributed human/no-tier", () => {
    const engine = new AttributionEngine({ corroborationStore: new CorroborationStore() });
    engine.open("doc1", "");
    engine.pushChanges(insertBatch("doc1", 0, "hello", { dirtyBefore: true, dirtyAfter: true }));
    assert.deepEqual(originsOf(engine.getRanges("doc1")), [["human", "null"]]);
  });

  test("a disk write while clean-before-and-after, corroborated by a lock file, is attributed ai/2a", () => {
    const store = new CorroborationStore();
    store.setSignal("ws1", { source: "lock-file", active: true, since: 0 });
    const engine = new AttributionEngine({ corroborationStore: store, resolveWorkspaceId: () => "ws1" });
    engine.open("doc1", "");
    engine.pushChanges(insertBatch("doc1", 0, "const x = 1;", { dirtyBefore: false, dirtyAfter: false }));
    assert.deepEqual(originsOf(engine.getRanges("doc1")), [["ai", "2a"]]);
  });

  test("a disk write while clean, with no corroboration, is external/3 -- never silently 'ai'", () => {
    const engine = new AttributionEngine({ corroborationStore: new CorroborationStore() });
    engine.open("doc1", "");
    engine.pushChanges(insertBatch("doc1", 0, "formatted", { dirtyBefore: false, dirtyAfter: false }));
    assert.deepEqual(originsOf(engine.getRanges("doc1")), [["external", "3"]]);
  });

  test("structural-only-insert (pure newline) passthrough inherits the touched position's existing origin", () => {
    const store = new CorroborationStore();
    store.setSignal("ws1", { source: "lock-file", active: true, since: 0 });
    const engine = new AttributionEngine({ corroborationStore: store, resolveWorkspaceId: () => "ws1" });
    engine.open("doc1", "");
    // AI writes "const x = 1;" while clean -> ai/2a.
    engine.pushChanges(insertBatch("doc1", 0, "const x = 1;", { dirtyBefore: false, dirtyAfter: false }));
    // Human then presses Enter in the middle of that AI-written line --
    // dirty-before/after would classify this "human", but it's a pure
    // whitespace insert, so it must inherit "ai"/"2a" instead.
    engine.pushChanges(insertBatch("doc1", 5, "\n", { dirtyBefore: true, dirtyAfter: true }));
    const ranges = engine.getRanges("doc1");
    assert.ok(ranges.every((r) => r.origin === "ai" && r.tier === "2a"));
  });

  test("a non-whitespace human insert at the same position is NOT passed through -- it's reattributed", () => {
    const store = new CorroborationStore();
    store.setSignal("ws1", { source: "lock-file", active: true, since: 0 });
    const engine = new AttributionEngine({ corroborationStore: store, resolveWorkspaceId: () => "ws1" });
    engine.open("doc1", "");
    engine.pushChanges(insertBatch("doc1", 0, "const x = 1;", { dirtyBefore: false, dirtyAfter: false }));
    engine.pushChanges(insertBatch("doc1", 5, "REAL_CODE", { dirtyBefore: true, dirtyAfter: true }));
    const ranges = engine.getRanges("doc1");
    assert.ok(ranges.some((r) => r.origin === "human"));
    assert.ok(ranges.some((r) => r.origin === "ai"));
  });

  test("undo restores the exact prior content-hash-keyed attribution instead of re-tagging by current dirty state", () => {
    const engine = new AttributionEngine({ corroborationStore: new CorroborationStore() });
    engine.open("doc1", "");
    // Human types "abc".
    engine.pushChanges(insertBatch("doc1", 0, "abc", { dirtyBefore: true, dirtyAfter: true, timestamp: 1 }));
    assert.deepEqual(originsOf(engine.getRanges("doc1")), [["human", "null"]]);

    // Undo removes "abc" back to "" -- engine should recall the empty-string
    // state's (empty) attribution.
    engine.pushChanges({
      docId: "doc1",
      changes: [{ rangeOffset: 0, rangeLength: 3, text: "" }],
      dirtyBefore: true,
      dirtyAfter: true,
      reason: "undo",
      timestamp: 2,
    });
    assert.deepEqual(engine.getRanges("doc1"), []);

    // Redo re-applies "abc" -- should restore it tagged "human" again, not
    // re-derive from current dirty state (which, if it were misapplied as a
    // fresh classification, could easily land differently).
    engine.pushChanges({
      docId: "doc1",
      changes: [{ rangeOffset: 0, rangeLength: 0, text: "abc" }],
      dirtyBefore: true,
      dirtyAfter: true,
      reason: "redo",
      timestamp: 3,
    });
    assert.deepEqual(originsOf(engine.getRanges("doc1")), [["human", "null"]]);
  });

  test("git-op suppression lands a would-be-ai disk write as unmarked (null/null), not ai or external", () => {
    const store = new CorroborationStore();
    store.setSignal("ws1", { source: "lock-file", active: true, since: 0 });
    const engine = new AttributionEngine({ corroborationStore: store, resolveWorkspaceId: () => "ws1" });
    engine.open("doc1", "");
    engine.setGitOpSuppression("ws1", true);
    engine.pushChanges(insertBatch("doc1", 0, "checked out content", { dirtyBefore: false, dirtyAfter: false }));
    assert.deepEqual(originsOf(engine.getRanges("doc1")), [["null", "null"]]);
  });

  test("an out-of-order multi-range batch (deliberately reversed) produces the same result as an in-order one", () => {
    const engine = new AttributionEngine({ corroborationStore: new CorroborationStore() });
    engine.open("doc1", "0123456789");
    const changes = [
      { rangeOffset: 0, rangeLength: 0, text: "AA" },
      { rangeOffset: 5, rangeLength: 0, text: "BB" },
    ];
    engine.pushChanges({ docId: "doc1", changes, dirtyBefore: true, dirtyAfter: true, reason: "typed", timestamp: 1 });
    const forward = engine.getRanges("doc1");

    const engine2 = new AttributionEngine({ corroborationStore: new CorroborationStore() });
    engine2.open("doc2", "0123456789");
    engine2.pushChanges({
      docId: "doc2",
      changes: [...changes].reverse(),
      dirtyBefore: true,
      dirtyAfter: true,
      reason: "typed",
      timestamp: 1,
    });
    const reversed = engine2.getRanges("doc2");

    assert.deepEqual(forward, reversed);
  });
});

describe("AttributionEngine -- whole-file-diff ingestion path (tracked-but-never-opened files)", () => {
  test("a corroborated Claude Code write to a never-opened file is classified ai/2a with no open document involved", () => {
    const store = new CorroborationStore();
    store.setSignal("ws1", { source: "lock-file", active: true, since: 0 });
    const engine = new AttributionEngine({ corroborationStore: store, resolveWorkspaceId: () => "ws1" });

    const ranges = engine.ingestWholeFileDiff({
      docId: "closed-file.ts",
      previousContent: "line1\nline2\n",
      newContent: "line1\nline2\nline3\n",
      timestamp: 1,
    });

    assert.deepEqual(
      ranges.map((r) => [r.origin, r.tier]),
      [
        [null, null],
        ["ai", "2a"],
      ]
    );
  });

  test("an uncorroborated write to a never-opened file is classified external/3, never ai", () => {
    const engine = new AttributionEngine({ corroborationStore: new CorroborationStore() });
    const ranges = engine.ingestWholeFileDiff({
      docId: "closed-file.ts",
      previousContent: "line1\nline2\n",
      newContent: "line1\nline2\nline3\n",
      timestamp: 1,
    });
    assert.deepEqual(
      ranges.map((r) => [r.origin, r.tier]),
      [
        [null, null],
        ["external", "3"],
      ]
    );
  });

  test("baseline chains across successive whole-file-diff calls for the same never-opened doc", () => {
    const engine = new AttributionEngine({ corroborationStore: new CorroborationStore() });
    engine.ingestWholeFileDiff({ docId: "f.ts", previousContent: "a\n", newContent: "a\nb\n", timestamp: 1 });
    // Second call omits previousContent -- engine must resolve it from its
    // own in-session state (now "a\nb\n"), not re-diff against "a\n" again.
    const ranges = engine.ingestWholeFileDiff({ docId: "f.ts", newContent: "a\nb\nc\n", timestamp: 2 });
    const lines = ranges.map((r) => [r.origin, r.tier]);
    // "a" and "b" stay unmarked/whatever they were; only "c" is fresh.
    assert.deepEqual(lines[lines.length - 1], ["external", "3"]);
  });
});
