import { describe, expect, it } from "vitest";
import { MockPersistence } from "../../src/vscode-integration/mocks/mock-persistence.ts";
import type { AttributedRange, RepoBranchKey } from "../../src/vscode-integration/contracts.ts";

const key: RepoBranchKey = { repoRoot: "/repo", branch: "main" };
const ranges: AttributedRange[] = [{ startOffset: 0, endOffset: 5, origin: "ai", tier: "2a", timestamp: 1 }];

describe("MockPersistence", () => {
  it("round-trips save/load when the content hash matches", async () => {
    const store = new MockPersistence();
    await store.save("file.ts", "hash1", key, ranges);
    expect(await store.load("file.ts", "hash1", key)).toEqual(ranges);
  });

  it("returns undefined when the content hash no longer matches (file changed since save)", async () => {
    const store = new MockPersistence();
    await store.save("file.ts", "hash1", key, ranges);
    expect(await store.load("file.ts", "hash2", key)).toBeUndefined();
  });

  it("does not collide two different docIds with identical content hash under the same key", async () => {
    const store = new MockPersistence();
    await store.save("a.ts", "same-hash", key, [{ startOffset: 0, endOffset: 1, origin: "ai", tier: "1", timestamp: 1 }]);
    await store.save("b.ts", "same-hash", key, [{ startOffset: 0, endOffset: 2, origin: "human", tier: null, timestamp: 1 }]);
    expect(await store.load("a.ts", "same-hash", key)).toHaveLength(1);
    expect(await store.load("b.ts", "same-hash", key)).toHaveLength(1);
    expect((await store.load("a.ts", "same-hash", key))?.[0].origin).toBe("ai");
    expect((await store.load("b.ts", "same-hash", key))?.[0].origin).toBe("human");
  });

  it("re-keys history on rename without loss", async () => {
    const store = new MockPersistence();
    await store.save("old.ts", "hash1", key, ranges);
    await store.rename("old.ts", "new.ts");
    expect(await store.load("old.ts", "hash1", key)).toBeUndefined();
    expect(await store.load("new.ts", "hash1", key)).toEqual(ranges);
  });

  it("listPersisted returns every docId saved under a given (repoRoot, branch)", async () => {
    const store = new MockPersistence();
    await store.save("a.ts", "h1", key, ranges);
    await store.save("b.ts", "h2", key, ranges);
    await store.save("c.ts", "h3", { repoRoot: "/other", branch: "main" }, ranges);
    const listed = await store.listPersisted(key);
    expect(new Set(listed.map((e) => e.docId))).toEqual(new Set(["a.ts", "b.ts"]));
  });

  it("git-notes mode-off leak check: pushNotes/fetchNotes make zero recorded calls when disabled", async () => {
    const store = new MockPersistence({ shareAttributionEnabled: false });
    await store.pushNotes("origin");
    await store.fetchNotes("origin");
    expect(store.pushCalls).toEqual([]);
    expect(store.fetchCalls).toEqual([]);
  });

  it("push/fetch record the remote name once enabled", async () => {
    const store = new MockPersistence({ shareAttributionEnabled: true });
    await store.pushNotes("origin");
    await store.fetchNotes("upstream");
    expect(store.pushCalls).toEqual(["origin"]);
    expect(store.fetchCalls).toEqual(["upstream"]);
  });

  it("writeNote/readNote work locally regardless of the shareAttribution toggle (GOAL1.md reading)", async () => {
    const store = new MockPersistence({ shareAttributionEnabled: false });
    const payload = { commitSha: "abc123", ranges, recordedAt: 1 };
    await store.writeNote("abc123", payload);
    expect(await store.readNote("abc123")).toEqual(payload);
  });

  it("resolveKey uses the injected resolver", async () => {
    const store = new MockPersistence({
      resolveKeyImpl: async () => ({ repoRoot: "/custom", branch: "feature" }),
    });
    const resolved = await store.resolveKey({ fsPath: "/custom/file.ts", toString: () => "file:///custom/file.ts" });
    expect(resolved).toEqual({ repoRoot: "/custom", branch: "feature" });
  });
});
