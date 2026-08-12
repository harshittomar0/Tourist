import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RealPersistenceAdapter } from "../../src/vscode-integration/persistence-adapter.ts";
import type { AttributedRange, RepoBranchKey } from "../../src/vscode-integration/contracts.ts";

const key: RepoBranchKey = { repoRoot: "/repo", branch: "main" };

describe("RealPersistenceAdapter (Mode A: real PersistenceManager, offset<->line reconciliation)", () => {
  let baseDir: string;
  let adapter: RealPersistenceAdapter;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "tourist-persistence-adapter-"));
    adapter = new RealPersistenceAdapter({
      baseDir,
      retentionDays: 0,
      gitNotesConfig: () => ({ enabled: false }),
      getRepoRoots: () => [],
    });
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("round-trips a save/load for a single-line ai range", async () => {
    const text = "const x = 1;\nconst y = 2;\n";
    const ranges: AttributedRange[] = [
      { startOffset: 0, endOffset: 13, origin: "ai", tier: "1", timestamp: 100 },
      { startOffset: 13, endOffset: text.length, origin: "human", tier: null, timestamp: 200 },
    ];
    await adapter.save("/repo/a.ts", "hash-unused", key, ranges, text);
    const restored = await adapter.load("/repo/a.ts", "hash-unused", key, text);
    expect(restored).toBeDefined();
    expect(restored!.map((r) => [r.startOffset, r.endOffset, r.origin])).toEqual([
      [0, 13, "ai"],
      [13, text.length, "human"],
    ]);
  });

  it("does not persist unmarked (origin: null) ranges, and load fills the gap back in on restore", async () => {
    const text = "AAA\nBBB\n";
    const ranges: AttributedRange[] = [
      { startOffset: 0, endOffset: 4, origin: "ai", tier: "2a", timestamp: 1 },
      { startOffset: 4, endOffset: text.length, origin: null, tier: null, timestamp: 1 },
    ];
    await adapter.save("/repo/b.ts", "h", key, ranges, text);
    const restored = await adapter.load("/repo/b.ts", "h", key, text);
    expect(restored!.map((r) => [r.startOffset, r.endOffset, r.origin])).toEqual([
      [0, 4, "ai"],
      [4, text.length, null],
    ]);
  });

  it("drops a stale entry whose text at its stored line-range no longer matches (content changed since persisting)", async () => {
    const original = "one\ntwo\nthree\n";
    await adapter.save("/repo/c.ts", "h", key, [{ startOffset: 4, endOffset: 7, origin: "ai", tier: "1", timestamp: 1 }], original);

    const changed = "one\nTWO\nthree\n"; // line 1's content changed since the save above
    const restored = await adapter.load("/repo/c.ts", "h", key, changed);
    // The stale "ai" entry for the old "two" text must not be trusted against
    // the new "TWO" content -- no valid persisted range survives validation,
    // so restore reports "nothing to restore" (undefined), same as a docId
    // with no persisted history at all -- the engine falls back to a fresh
    // unmarked table either way.
    expect(restored === undefined || restored.every((r) => r.origin === null)).toBe(true);
  });

  it("rename re-keys persisted history under the new path, found by content not path", async () => {
    const text = "hello world\n";
    await adapter.save("/repo/old.ts", "h", key, [{ startOffset: 0, endOffset: text.length, origin: "ai", tier: "1", timestamp: 1 }], text);

    await adapter.rename("/repo/old.ts", "/repo/new.ts", key);

    const restored = await adapter.load("/repo/new.ts", "h", key, text);
    expect(restored!.some((r) => r.origin === "ai")).toBe(true);
  });

  it("listPersisted aggregates entries per docId across the whole (repoRoot, branch) store", async () => {
    await adapter.save("/repo/a.ts", "h", key, [{ startOffset: 0, endOffset: 5, origin: "ai", tier: "1", timestamp: 1 }], "aaaaa");
    await adapter.save("/repo/b.ts", "h", key, [{ startOffset: 0, endOffset: 3, origin: "human", tier: null, timestamp: 1 }], "bbb");

    const listed = await adapter.listPersisted(key);
    const byDocId = new Map(listed.map((e) => [e.docId, e.ranges]));
    expect(byDocId.get("/repo/a.ts")?.[0].origin).toBe("ai");
    expect(byDocId.get("/repo/b.ts")?.[0].origin).toBe("human");
  });

  it("resolveKey falls back to a degenerate but stable key when no .git is found", async () => {
    const uri = { fsPath: join(baseDir, "not-a-repo", "file.ts"), toString: () => "" };
    const resolved = await adapter.resolveKey(uri);
    expect(resolved.repoRoot).toBe(uri.fsPath);
  });
});
