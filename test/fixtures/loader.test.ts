import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { loadFixture, applyFixture } from "./loader.ts";

function originsOf(ranges: { origin: string | null; tier: string | null }[]): Array<[string, string | null]> {
  return ranges.map((r) => [r.origin ?? "null", r.tier ?? "null"]);
}

describe("shared fixture format (test/fixtures/) -- proves each scenario replays against the real engine", () => {
  test("human-edit-basic", () => {
    const { rangesByDocId } = applyFixture(loadFixture("human-edit-basic"));
    assert.deepEqual(originsOf(rangesByDocId.get("doc1")!), [["human", "null"]]);
  });

  test("ai-write-lockfile-corroborated", () => {
    const { rangesByDocId } = applyFixture(loadFixture("ai-write-lockfile-corroborated"));
    assert.deepEqual(originsOf(rangesByDocId.get("doc1")!), [["ai", "2a"]]);
  });

  test("external-write-uncorroborated", () => {
    const { rangesByDocId } = applyFixture(loadFixture("external-write-uncorroborated"));
    assert.deepEqual(originsOf(rangesByDocId.get("doc1")!), [["external", "3"]]);
  });

  test("structural-insert-passthrough", () => {
    const { rangesByDocId } = applyFixture(loadFixture("structural-insert-passthrough"));
    const ranges = rangesByDocId.get("doc1")!;
    assert.ok(ranges.every((r) => r.origin === "ai" && r.tier === "2a"));
  });

  test("non-whitespace-reattached", () => {
    const { rangesByDocId } = applyFixture(loadFixture("non-whitespace-reattached"));
    const ranges = rangesByDocId.get("doc1")!;
    assert.ok(ranges.some((r) => r.origin === "human"));
    assert.ok(ranges.some((r) => r.origin === "ai"));
  });

  test("git-op-suppression", () => {
    const { rangesByDocId } = applyFixture(loadFixture("git-op-suppression"));
    assert.deepEqual(originsOf(rangesByDocId.get("doc1")!), [["null", "null"]]);
  });

  test("whole-file-diff-never-opened", () => {
    const { rangesByDocId } = applyFixture(loadFixture("whole-file-diff-never-opened"));
    assert.deepEqual(originsOf(rangesByDocId.get("closed-file.ts")!), [
      ["null", "null"],
      ["ai", "2a"],
    ]);
  });

  test("whole-file-diff-uncorroborated", () => {
    const { rangesByDocId } = applyFixture(loadFixture("whole-file-diff-uncorroborated"));
    assert.deepEqual(originsOf(rangesByDocId.get("closed-file.ts")!), [
      ["null", "null"],
      ["external", "3"],
    ]);
  });

  test("loadFixture rejects a filename/internal-name mismatch", () => {
    assert.throws(() => loadFixture("human-edit-basic-typo" as never));
  });
});
