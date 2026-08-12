import { describe, expect, it } from "vitest";
import { MockAttributionEngine } from "../../src/vscode-integration/mocks/mock-engine.ts";
import type { NormalizedChangeBatch } from "../../src/vscode-integration/contracts.ts";

function typed(docId: string, rangeOffset: number, rangeLength: number, text: string, dirtyBefore: boolean, dirtyAfter: boolean): NormalizedChangeBatch {
  return { docId, changes: [{ rangeOffset, rangeLength, text }], dirtyBefore, dirtyAfter, reason: "typed", timestamp: 1 };
}

describe("MockAttributionEngine", () => {
  it("classifies a typed edit (dirty before or after) as human", () => {
    const engine = new MockAttributionEngine();
    engine.open("doc1", "hello world");
    const ranges = engine.pushChanges(typed("doc1", 0, 5, "howdy", true, true));
    expect(ranges.some((r) => r.origin === "human")).toBe(true);
  });

  it("classifies a clean-before-and-after edit as external when uncorroborated (Tier 3)", () => {
    const engine = new MockAttributionEngine();
    engine.open("doc1", "hello world");
    const ranges = engine.pushChanges(typed("doc1", 0, 5, "howdy", false, false));
    expect(ranges.some((r) => r.origin === "external" && r.tier === "3")).toBe(true);
  });

  it("classifies a clean-before-and-after edit as ai when the workspace is corroborated (Tier 2a)", () => {
    const engine = new MockAttributionEngine();
    engine.resolveWorkspaceId = (docId) => docId;
    engine.setCorroborationActive("doc1", true);
    engine.open("doc1", "hello world");
    const ranges = engine.pushChanges(typed("doc1", 0, 5, "howdy", false, false));
    expect(ranges.some((r) => r.origin === "ai" && r.tier === "2a")).toBe(true);
  });

  it("suppresses classification (null origin) during a git-op suppression window", () => {
    const engine = new MockAttributionEngine();
    engine.open("doc1", "hello world");
    engine.setGitOpSuppression("doc1", true);
    const ranges = engine.pushChanges(typed("doc1", 0, 5, "howdy", false, false));
    expect(ranges.every((r) => r.origin === null)).toBe(true);
  });

  it("restores exact prior tags on undo landing back on a remembered content state", () => {
    const engine = new MockAttributionEngine();
    engine.open("doc1", "hello world");
    engine.pushChanges(typed("doc1", 0, 5, "howdy", true, true)); // -> "howdy world", human
    const afterEdit = engine.getRanges("doc1");
    expect(afterEdit.find((r) => r.origin === "human")).toBeDefined();

    // Undo: text reverts to "hello world" (an edit that removes "howdy" and reinserts "hello")
    const undone = engine.pushChanges({
      docId: "doc1",
      changes: [{ rangeOffset: 0, rangeLength: 5, text: "hello" }],
      dirtyBefore: true,
      dirtyAfter: true,
      reason: "undo",
      timestamp: 2,
    });
    // Landed back on the exact original (all-null) content state.
    expect(undone.every((r) => r.origin === null)).toBe(true);
  });

  it("applies a multi-change batch correctly regardless of the array's original order", () => {
    const engine = new MockAttributionEngine();
    engine.open("doc1", "0123456789");
    // Two inserts in the same batch, deliberately given ascending (not the
    // real editor's typical descending) order -- see PLAN1.md Phase 4's
    // contentChanges-ordering row.
    const ranges = engine.pushChanges({
      docId: "doc1",
      changes: [
        { rangeOffset: 2, rangeLength: 0, text: "AA" },
        { rangeOffset: 6, rangeLength: 0, text: "BB" },
      ],
      dirtyBefore: true,
      dirtyAfter: true,
      reason: "typed",
      timestamp: 1,
    });
    const total = ranges.reduce((sum, r) => sum + (r.endOffset - r.startOffset), 0);
    expect(total).toBe(14); // 10 original chars + 2 + 2 inserted
  });

  it("ingestWholeFileDiff classifies the whole file as one span and is a no-op when content is unchanged", () => {
    const engine = new MockAttributionEngine();
    const first = engine.ingestWholeFileDiff({ docId: "closed.ts", newContent: "abc", timestamp: 1 });
    expect(first).toEqual([{ startOffset: 0, endOffset: 3, origin: "external", tier: "3", timestamp: 1 }]);

    const unchanged = engine.ingestWholeFileDiff({ docId: "closed.ts", newContent: "abc", timestamp: 2 });
    expect(unchanged).toEqual(first);
  });

  it("listTrackedDocIds reflects every document the engine has seen, open or diffed", () => {
    const engine = new MockAttributionEngine();
    engine.open("open.ts", "content");
    engine.ingestWholeFileDiff({ docId: "closed.ts", newContent: "abc", timestamp: 1 });
    expect(new Set(engine.listTrackedDocIds())).toEqual(new Set(["open.ts", "closed.ts"]));
  });

  it("close removes a document from tracked state", () => {
    const engine = new MockAttributionEngine();
    engine.open("doc1", "hello");
    engine.close("doc1");
    expect(engine.listTrackedDocIds()).toEqual([]);
    expect(engine.getRanges("doc1")).toEqual([]);
  });

  it("notifies onDidChangeRanges listeners after a push, and stops after dispose", () => {
    const engine = new MockAttributionEngine();
    engine.open("doc1", "hello");
    let notified = 0;
    const sub = engine.onDidChangeRanges(() => notified++);
    engine.pushChanges(typed("doc1", 0, 0, "!", true, true));
    expect(notified).toBe(1);
    sub.dispose();
    engine.pushChanges(typed("doc1", 0, 0, "!", true, true));
    expect(notified).toBe(1);
  });
});
