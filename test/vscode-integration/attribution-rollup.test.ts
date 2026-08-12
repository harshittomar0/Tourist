import { describe, expect, it } from "vitest";
import { collectWorkspaceRollup } from "../../src/vscode-integration/attribution-rollup.ts";
import { MockAttributionEngine } from "../../src/vscode-integration/mocks/mock-engine.ts";
import { MockPersistence } from "../../src/vscode-integration/mocks/mock-persistence.ts";

const key = { repoRoot: "/repo", branch: "main" };

describe("collectWorkspaceRollup", () => {
  it("prefers live engine state over persisted state for the same docId", async () => {
    const engine = new MockAttributionEngine();
    const persistence = new MockPersistence();
    engine.open("/repo/a.ts", "hello"); // baseline (null) in the live engine
    await persistence.save("/repo/a.ts", "stale-hash", key, [{ startOffset: 0, endOffset: 5, origin: "ai", tier: "1", timestamp: 1 }]);

    const rollup = await collectWorkspaceRollup({ engine, persistence, folders: [{ path: "/repo", key }] });
    expect(rollup.files).toHaveLength(1);
    // Live engine's ranges win (all-null baseline -> zero counted stats),
    // not the stale persisted "ai" entry.
    expect(rollup.files[0]).toEqual({ docId: "/repo/a.ts", stats: { ai: 0, human: 0, external: 0, total: 0 } });
  });

  it("includes a tracked file that was never opened this session, from persistence alone", async () => {
    const engine = new MockAttributionEngine();
    const persistence = new MockPersistence();
    await persistence.save("/repo/never-opened.ts", "h1", key, [{ startOffset: 0, endOffset: 10, origin: "human", tier: null, timestamp: 1 }]);

    const rollup = await collectWorkspaceRollup({ engine, persistence, folders: [{ path: "/repo", key }] });
    expect(rollup.files).toEqual([{ docId: "/repo/never-opened.ts", stats: { ai: 0, human: 10, external: 0, total: 10 } }]);
    expect(rollup.total).toEqual({ ai: 0, human: 10, external: 0, total: 10 });
  });

  it("excludes a file the tracking-scope predicate rejects, from both sources", async () => {
    const engine = new MockAttributionEngine();
    const persistence = new MockPersistence();
    engine.open("/repo/node_modules/pkg/index.js", "junk");
    await persistence.save("/repo/dist/out.js", "h1", key, [{ startOffset: 0, endOffset: 5, origin: "ai", tier: "1", timestamp: 1 }]);

    const rollup = await collectWorkspaceRollup({
      engine,
      persistence,
      folders: [{ path: "/repo", key }],
      isTracked: (p) => !p.includes("node_modules") && !p.includes("/dist/"),
    });
    expect(rollup.files).toEqual([]);
  });

  it("scopes docIds to their own folder and never mixes two folders' totals", async () => {
    const engine = new MockAttributionEngine();
    const persistence = new MockPersistence();
    engine.pushChanges({ docId: "/repoA/a.ts", changes: [{ rangeOffset: 0, rangeLength: 0, text: "x" }], dirtyBefore: true, dirtyAfter: true, reason: "typed", timestamp: 1 });
    engine.pushChanges({ docId: "/repoB/b.ts", changes: [{ rangeOffset: 0, rangeLength: 0, text: "yy" }], dirtyBefore: true, dirtyAfter: true, reason: "typed", timestamp: 1 });

    const rollup = await collectWorkspaceRollup({
      engine,
      persistence,
      folders: [
        { path: "/repoA", key: { repoRoot: "/repoA", branch: "main" } },
        { path: "/repoB", key: { repoRoot: "/repoB", branch: "main" } },
      ],
    });
    expect(rollup.files.find((f) => f.docId === "/repoA/a.ts")?.stats.human).toBe(1);
    expect(rollup.files.find((f) => f.docId === "/repoB/b.ts")?.stats.human).toBe(2);
    expect(rollup.total.human).toBe(3);
  });
});
