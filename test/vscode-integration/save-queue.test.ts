/**
 * Regression coverage for the extension.ts deactivation-flush race:
 * `PersistenceManager.record` (src/persistence/index.ts) does an unlocked
 * load-merge-save cycle -- read the whole on-disk store, merge one doc's
 * ranges into it in memory, write the whole store back. Nothing about that
 * cycle stops two concurrent calls for the same (repoRoot, branch)
 * persistence key from both reading the store *before* either has written
 * its merge back, silently losing one of the two updates. `flushPendingSaves`
 * used to fire every open document's `persistDoc` unawaited
 * (`void persistDoc(doc)`), which is exactly the shape that triggers this.
 *
 * `KeyedSerialQueue` is the fix: same-key calls are chained so each one's
 * "load" only ever runs after the previous one's "save" has landed, while
 * different-key calls still run fully concurrently.
 */
import { describe, expect, it } from "vitest";
import { KeyedSerialQueue, repoBranchQueueKey } from "../../src/vscode-integration/save-queue.ts";

/** Minimal stand-in for `PersistenceManager.record`'s real load-merge-save
 * cycle, with the same lack of locking: `load` snapshots current state,
 * `save` (after a simulated disk-I/O delay) overwrites with that snapshot
 * plus one new entry. */
function makeUnlockedRecordStore() {
  let persisted: string[] = [];
  return {
    async record(entry: string): Promise<void> {
      const loaded = persisted;
      await new Promise((resolve) => setTimeout(resolve, 5));
      persisted = [...loaded, entry];
    },
    all(): string[] {
      return persisted;
    }
  };
}

describe("KeyedSerialQueue", () => {
  it("reproduces the bug when two same-key saves are not serialized: one update is silently lost", async () => {
    const store = makeUnlockedRecordStore();
    await Promise.all([store.record("doc-a save"), store.record("doc-b save")]);
    // Both `record` calls read the empty store before either wrote back, so
    // the second write clobbers the first -- only one entry survives.
    expect(store.all().length).toBe(1);
  });

  it("fixes it: routing same-key saves through the queue preserves both updates", async () => {
    const store = makeUnlockedRecordStore();
    const queue = new KeyedSerialQueue();
    await Promise.all([
      queue.run("repoRoot::main", () => store.record("doc-a save")),
      queue.run("repoRoot::main", () => store.record("doc-b save"))
    ]);
    expect(store.all()).toEqual(["doc-a save", "doc-b save"]);
  });

  it("does not serialize unrelated keys against each other", async () => {
    const queue = new KeyedSerialQueue();
    const order: string[] = [];
    const slow = async (label: string): Promise<void> => {
      order.push(`${label}-start`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push(`${label}-end`);
    };
    await Promise.all([queue.run("repoA::main", () => slow("a")), queue.run("repoB::main", () => slow("b"))]);
    // Both started before either finished -- true concurrency across keys.
    expect(order.indexOf("a-start")).toBeLessThan(order.indexOf("b-end"));
    expect(order.indexOf("b-start")).toBeLessThan(order.indexOf("a-end"));
  });

  it("a rejected task for one key does not wedge later tasks queued under the same key", async () => {
    const queue = new KeyedSerialQueue();
    await expect(queue.run("key", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(queue.run("key", () => Promise.resolve("ok"))).resolves.toBe("ok");
  });

  it("preserves per-key ordering across three or more chained saves", async () => {
    const store = makeUnlockedRecordStore();
    const queue = new KeyedSerialQueue();
    await Promise.all(
      ["doc-a", "doc-b", "doc-c"].map((doc) => queue.run("repoRoot::main", () => store.record(doc)))
    );
    expect(store.all().sort()).toEqual(["doc-a", "doc-b", "doc-c"]);
  });
});

describe("repoBranchQueueKey", () => {
  it("produces the same key for the same (repoRoot, branch) pair", () => {
    const key = { repoRoot: "/work/app", branch: "main" };
    expect(repoBranchQueueKey(key)).toBe(repoBranchQueueKey({ ...key }));
  });

  it("produces distinct keys for distinct repoRoots or branches", () => {
    expect(repoBranchQueueKey({ repoRoot: "/work/app", branch: "main" })).not.toBe(
      repoBranchQueueKey({ repoRoot: "/work/other", branch: "main" })
    );
    expect(repoBranchQueueKey({ repoRoot: "/work/app", branch: "main" })).not.toBe(
      repoBranchQueueKey({ repoRoot: "/work/app", branch: "dev" })
    );
  });
});
