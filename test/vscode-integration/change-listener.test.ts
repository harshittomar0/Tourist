import { describe, expect, it } from "vitest";
import {
  DirtyTracker,
  docIdFor,
  toChangeReason,
  toNormalizedChange,
  toNormalizedChangeBatch,
} from "../../src/vscode-integration/change-listener.ts";

// Fake enum mirroring vscode.TextDocumentChangeReason, passed explicitly
// (change-listener.ts takes it as a parameter precisely so tests don't need
// the real `vscode` module resolvable).
const FakeChangeReason = { Undo: 1, Redo: 2 } as unknown as typeof import("vscode").TextDocumentChangeReason;

describe("docIdFor", () => {
  it("uses the URI's fsPath", () => {
    expect(docIdFor({ fsPath: "/a/b.ts" } as any)).toBe("/a/b.ts");
  });
});

describe("toNormalizedChange", () => {
  it("is a pure reshape of rangeOffset/rangeLength/text", () => {
    const change = { rangeOffset: 5, rangeLength: 2, text: "hi", range: {} } as any;
    expect(toNormalizedChange(change)).toEqual({ rangeOffset: 5, rangeLength: 2, text: "hi" });
  });
});

describe("toChangeReason", () => {
  it("maps Undo/Redo and defaults everything else to typed", () => {
    expect(toChangeReason(FakeChangeReason.Undo, FakeChangeReason)).toBe("undo");
    expect(toChangeReason(FakeChangeReason.Redo, FakeChangeReason)).toBe("redo");
    expect(toChangeReason(undefined, FakeChangeReason)).toBe("typed");
  });
});

describe("toNormalizedChangeBatch", () => {
  it("returns undefined for an empty contentChanges array (nothing to report)", () => {
    const event = { document: { uri: { fsPath: "/a.ts" }, isDirty: true } as any, contentChanges: [], reason: undefined };
    expect(toNormalizedChangeBatch(event, false, FakeChangeReason)).toBeUndefined();
  });

  it("carries dirtyBefore from the caller and dirtyAfter from the live document", () => {
    const event = {
      document: { uri: { fsPath: "/a.ts" }, isDirty: true } as any,
      contentChanges: [{ rangeOffset: 0, rangeLength: 0, text: "x", range: {} }] as any,
      reason: undefined,
    };
    const batch = toNormalizedChangeBatch(event, false, FakeChangeReason, 42);
    expect(batch).toEqual({
      docId: "/a.ts",
      changes: [{ rangeOffset: 0, rangeLength: 0, text: "x" }],
      dirtyBefore: false,
      dirtyAfter: true,
      reason: "typed",
      timestamp: 42,
    });
  });
});

describe("DirtyTracker", () => {
  it("reports false as the dirty-before for a never-seen document", () => {
    const tracker = new DirtyTracker();
    expect(tracker.consume("doc1", true)).toBe(false);
  });

  it("returns the flag as of before this change, then updates it", () => {
    const tracker = new DirtyTracker();
    tracker.onOpen("doc1", false);
    expect(tracker.consume("doc1", true)).toBe(false); // was clean, now dirty
    expect(tracker.consume("doc1", true)).toBe(true); // was dirty, still dirty
    expect(tracker.consume("doc1", false)).toBe(true); // was dirty, now clean (save)
  });

  it("forgets state on close", () => {
    const tracker = new DirtyTracker();
    tracker.onOpen("doc1", true);
    tracker.onClose("doc1");
    expect(tracker.consume("doc1", true)).toBe(false);
  });
});
