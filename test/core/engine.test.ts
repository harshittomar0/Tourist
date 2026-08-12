import { test, describe } from "vitest";
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

  test("race: a disk write classified before setGitOpSuppression(true) is retroactively unmarked once suppression arrives", () => {
    // Reproduces the real-world race: vscode.git's repository.state.onDidChange
    // (extension.ts's only trigger for setGitOpSuppression) fires 1.2-3.5s
    // *after* the git command that caused it (spike/FINDINGS.md Experiment
    // 6), while Tourist's own disk watcher reacts far faster. So the disk
    // write from `git checkout -b tmp` lands and gets classified (here:
    // ai/2a, corroborated by a stale lock file) *before* suppression turns
    // on -- the opposite of the intended ordering.
    const store = new CorroborationStore();
    store.setSignal("ws1", { source: "lock-file", active: true, since: 0 });
    const engine = new AttributionEngine({ corroborationStore: store, resolveWorkspaceId: () => "ws1" });
    engine.open("doc1", "");
    engine.pushChanges(
      insertBatch("doc1", 0, "checked out content", { dirtyBefore: false, dirtyAfter: false, timestamp: Date.now() })
    );
    assert.deepEqual(originsOf(engine.getRanges("doc1")), [["ai", "2a"]]);

    // The git extension's event finally arrives, shortly after the write it
    // was meant to guard.
    engine.setGitOpSuppression("ws1", true);

    // Fixed: retroactively corrected to unmarked, not left as a
    // misattributed "ai" edit.
    assert.deepEqual(originsOf(engine.getRanges("doc1")), [["null", "null"]]);
  });

  test("race grace period does not touch a genuine tier-1 hook match, even inside the window", () => {
    const store = new CorroborationStore();
    const hookLogReader: import("../../src/core/adapter-interfaces.ts").HookLogReaderAdapter = {
      install: async () => ({ alreadyInstalled: true }),
      isInstalled: async () => true,
      matchesContent: () => true,
      matchesSpan: () => false,
      onDidAppendRecord: () => ({ dispose: () => {} }),
      dispose: () => {},
    };
    const engine = new AttributionEngine({ corroborationStore: store, resolveWorkspaceId: () => "ws1", hookLogReader });
    engine.open("doc1", "");
    engine.pushChanges(
      insertBatch("doc1", 0, "claude wrote this", { dirtyBefore: false, dirtyAfter: false, timestamp: Date.now() })
    );
    assert.deepEqual(originsOf(engine.getRanges("doc1")), [["ai", "1"]]);

    engine.setGitOpSuppression("ws1", true);

    // A real, content-hash-confirmed AI write isn't a heuristic guess caught
    // in the git-op race -- it must survive the retroactive pass unchanged.
    assert.deepEqual(originsOf(engine.getRanges("doc1")), [["ai", "1"]]);
  });

  test("race grace period does not touch a recent human edit, or a disk write outside the window", () => {
    const store = new CorroborationStore();
    const engine = new AttributionEngine({ corroborationStore: store, resolveWorkspaceId: () => "ws1" });
    engine.open("doc1", "");
    // Recent, but "human" -- never eligible for retroactive reclassification
    // regardless of timing.
    engine.pushChanges(
      insertBatch("doc1", 0, "human typed", { dirtyBefore: true, dirtyAfter: true, timestamp: Date.now() })
    );
    // Old enough (a stale fixture timestamp, nowhere near real Date.now())
    // to fall outside the retroactive window even though its origin/tier
    // would otherwise be eligible.
    engine.pushChanges(
      insertBatch("doc1", 11, "old external write", { dirtyBefore: false, dirtyAfter: false, timestamp: 1000 })
    );

    engine.setGitOpSuppression("ws1", true);
    assert.deepEqual(originsOf(engine.getRanges("doc1")), [
      ["human", "null"],
      ["external", "3"],
    ]);
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

    // Compare shape/classification, not `timestamp`: the untouched filler
    // ranges' timestamp comes from each engine's own `open()` call
    // internally defaulting to `Date.now()` (no timestamp parameter is
    // exposed on `open`), so two independently-opened engines can
    // legitimately differ there by a millisecond -- not what this test is
    // asserting (order-independence of the classification itself).
    const shapeOf = (ranges: ReturnType<AttributionEngine["getRanges"]>) =>
      ranges.map((r) => [r.startOffset, r.endOffset, r.origin, r.tier]);
    assert.deepEqual(shapeOf(forward), shapeOf(reversed));
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

describe("AttributionEngine -- reload (branch-switch / stash-pop data-loss fix)", () => {
  test("reload overwrites an already-tracked doc's ranges, unlike open() which no-ops", () => {
    const engine = new AttributionEngine({ corroborationStore: new CorroborationStore() });
    engine.open("doc1", "hello");
    engine.pushChanges(insertBatch("doc1", 5, " world", { dirtyBefore: true, dirtyAfter: true }));
    assert.deepEqual(originsOf(engine.getRanges("doc1")), [
      ["null", "null"],
      ["human", "null"],
    ]);

    // open() on an already-tracked doc is a documented no-op -- this is
    // exactly why extension.ts could never use it to pick up a git-caused
    // content revert on a still-open document.
    const viaOpen = engine.open("doc1", "hello world", [
      { startOffset: 0, endOffset: 11, origin: "ai", tier: "2a", timestamp: 1 },
    ]);
    assert.deepEqual(originsOf(viaOpen), [
      ["null", "null"],
      ["human", "null"],
    ]);

    const viaReload = engine.reload("doc1", "hello world", [
      { startOffset: 0, endOffset: 11, origin: "ai", tier: "2a", timestamp: 1 },
    ]);
    assert.deepEqual(originsOf(viaReload), [["ai", "2a"]]);
    assert.deepEqual(originsOf(engine.getRanges("doc1")), [["ai", "2a"]]);
  });

  test("reload with no matching restore falls back to a fresh unmarked table, not the stale live one", () => {
    const engine = new AttributionEngine({ corroborationStore: new CorroborationStore() });
    engine.open("doc1", "hello");
    engine.pushChanges(insertBatch("doc1", 0, "AI wrote this", { dirtyBefore: false, dirtyAfter: false }));
    assert.ok(engine.getRanges("doc1").some((r) => r.origin !== null));

    // Simulates switching to a branch with no persisted history for this
    // content: nothing to restore.
    const reloaded = engine.reload("doc1", "different content", undefined);
    assert.deepEqual(originsOf(reloaded), [["null", "null"]]);
  });

  test("reload preserves each restored range's own timestamp, so it survives a later retroactive git-op reclassification (tourist-18 interaction)", () => {
    const store = new CorroborationStore();
    const engine = new AttributionEngine({ corroborationStore: store, resolveWorkspaceId: () => "ws1" });
    engine.open("doc1", "");

    // Attribution genuinely persisted a while ago (well outside the 4s
    // retroactive-reclassification window) -- e.g. restored after switching
    // back to a branch last touched minutes ago.
    const oldTimestamp = Date.now() - 60_000;
    engine.reload("doc1", "old ai content", [
      { startOffset: 0, endOffset: "old ai content".length, origin: "ai", tier: "2a", timestamp: oldTimestamp },
    ]);
    assert.deepEqual(originsOf(engine.getRanges("doc1")), [["ai", "2a"]]);

    // A git op is detected around the same time this reload happens (e.g.
    // the branch-switch that triggered the reload also fires
    // repo.state.onDidChange, arriving at markGitActivity moments later).
    engine.setGitOpSuppression("ws1", true);

    // Must NOT be wiped by reclassifyRecentDiskWrites: had reload() instead
    // stamped these ranges with Date.now(), they'd look like a
    // just-classified heuristic guess caught in the race window and get
    // retroactively nulled -- exactly the fight with tourist-18's fix this
    // method's doc comment calls out.
    assert.deepEqual(originsOf(engine.getRanges("doc1")), [["ai", "2a"]]);
  });

  test("sanity check: a reload landing with a genuinely recent timestamp inside the window IS reclassified -- proving the above passes because of preserved timestamps, not because reload is somehow immune", () => {
    const store = new CorroborationStore();
    const engine = new AttributionEngine({ corroborationStore: store, resolveWorkspaceId: () => "ws1" });
    engine.open("doc1", "");

    const recentTimestamp = Date.now() - 500; // well inside GIT_OP_RETROACTIVE_WINDOW_MS (4s)
    engine.reload("doc1", "recent ai content", [
      { startOffset: 0, endOffset: "recent ai content".length, origin: "ai", tier: "2a", timestamp: recentTimestamp },
    ]);
    assert.deepEqual(originsOf(engine.getRanges("doc1")), [["ai", "2a"]]);

    engine.setGitOpSuppression("ws1", true);
    assert.deepEqual(originsOf(engine.getRanges("doc1")), [["null", "null"]]);
  });
});

describe("AttributionEngine -- enumeration + rename (contract §2 additions)", () => {
  test("listTrackedDocIds returns every open or diffed document identity", () => {
    const engine = new AttributionEngine({ corroborationStore: new CorroborationStore() });
    engine.open("doc1", "hello");
    engine.ingestWholeFileDiff({ docId: "doc2", newContent: "world", timestamp: 1 });
    assert.deepEqual(new Set(engine.listTrackedDocIds()), new Set(["doc1", "doc2"]));
  });

  test("renameDocument moves live in-memory state (ranges + undo history) to the new docId in place", () => {
    const engine = new AttributionEngine({ corroborationStore: new CorroborationStore() });
    engine.open("old.ts", "0123456789");
    engine.pushChanges(insertBatch("old.ts", 0, "AI"));
    const before = engine.getRanges("old.ts");

    engine.renameDocument("old.ts", "new.ts");

    assert.deepEqual(engine.getRanges("new.ts"), before);
    assert.deepEqual(engine.getRanges("old.ts"), []);
    assert.deepEqual(engine.listTrackedDocIds(), ["new.ts"]);

    // Undo/redo history moved too -- a redo after rename still restores by
    // content hash rather than losing history the way close+reopen would.
    engine.pushChanges({
      docId: "new.ts",
      changes: [{ rangeOffset: 0, rangeLength: 2, text: "" }],
      dirtyBefore: true,
      dirtyAfter: true,
      reason: "typed",
      timestamp: 2,
    });
    const redone = engine.pushChanges({
      docId: "new.ts",
      changes: [{ rangeOffset: 0, rangeLength: 0, text: "AI" }],
      dirtyBefore: true,
      dirtyAfter: true,
      reason: "redo",
      timestamp: 3,
    });
    assert.deepEqual(redone, before);
  });

  test("renameDocument on an untracked docId is a no-op, not an error", () => {
    const engine = new AttributionEngine({ corroborationStore: new CorroborationStore() });
    assert.doesNotThrow(() => engine.renameDocument("missing.ts", "also-missing.ts"));
    assert.deepEqual(engine.listTrackedDocIds(), []);
  });
});
