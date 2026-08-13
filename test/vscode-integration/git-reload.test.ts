/**
 * Reproduces (and, with the fix in place, proves closed) the real-world
 * data-loss bug: switching git branches or doing `git stash push`+`pop`
 * loses all AI/human line attribution for a document that stays open the
 * whole time.
 *
 * Drives the exact same pieces extension.ts wires together --
 * `AttributionEngine`, `RealPersistenceAdapter` (real file-backed
 * persistence, real `resolveKeyForFile` git-context resolution via the raw
 * fs fallback -- no `vscode.git` API needed), and the new
 * `reconcileAfterGitChange` coordinator -- against a real temporary git
 * repository and real `git` commands, without needing the `vscode` module
 * itself (which none of these three modules import).
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AttributionEngine } from "../../src/core/engine.ts";
import { CorroborationStore } from "../../src/core/corroboration-store.ts";
import { RealPersistenceAdapter } from "../../src/vscode-integration/persistence-adapter.ts";
import { reconcileAfterGitChange, type OpenDocSnapshot } from "../../src/vscode-integration/git-reload.ts";
import type { RepoBranchKey } from "../../src/vscode-integration/contracts.ts";
import { computeStats, percentagesOf } from "../../src/vscode-integration/stats.ts";
import { resolveGitContextFallback } from "../../src/persistence/index.ts";
import type { VscodeGitAPI, VscodeGitRepository } from "../../src/persistence/vscodeGitTypes.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Tourist Test", "-c", "user.email=tourist-test@example.com", ...args],
    { cwd, encoding: "utf8" }
  ).trim();
}

function originsOf(engine: AttributionEngine, docId: string): Array<[string, string | null]> {
  return engine.getRanges(docId).map((r) => [r.origin ?? "null", r.tier ?? "null"]);
}

describe("branch-switch / stash-pop attribution round trip (real git repo)", () => {
  let repoDir: string;
  let baseDir: string;
  let docId: string;
  let engine: AttributionEngine;
  let persistence: RealPersistenceAdapter;
  let folderKeyCache: Map<string, RepoBranchKey>;

  // Mirrors extension.ts's own keyFor/restoreFor/persistDoc closures closely
  // enough to exercise the real bug: a single cache shared across every
  // lookup, invalidated only by reconcileAfterGitChange.
  async function keyFor(folderPath: string): Promise<RepoBranchKey> {
    const cached = folderKeyCache.get(folderPath);
    if (cached) return cached;
    const key = await persistence.resolveKey({ fsPath: folderPath, toString: () => folderPath });
    folderKeyCache.set(folderPath, key);
    return key;
  }

  async function restoreFor(id: string) {
    const text = await readFile(id, "utf8");
    const key = await keyFor(repoDir);
    return persistence.load(id, "", key, text);
  }

  async function persistDoc(id: string, text: string): Promise<void> {
    const key = await keyFor(repoDir);
    await persistence.save(id, "", key, engine.getRanges(id), text);
  }

  async function reconcile(text: string): Promise<void> {
    const snapshot: OpenDocSnapshot = { docId, folderPath: repoDir, text };
    await reconcileAfterGitChange(
      { folderKeyCache, restore: (id) => restoreFor(id), reloadEngine: (id, t, restore) => void engine.reload(id, t, restore) },
      [repoDir],
      [snapshot]
    );
  }

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "tourist-git-reload-repo-"));
    baseDir = await mkdtemp(join(tmpdir(), "tourist-git-reload-store-"));
    git(repoDir, ["init", "-q", "-b", "main"]);
    docId = join(repoDir, "file.txt");

    engine = new AttributionEngine({ corroborationStore: new CorroborationStore() });
    persistence = new RealPersistenceAdapter({
      baseDir,
      retentionDays: 30,
      getRepoRoots: () => [repoDir],
      gitNotesConfig: () => ({ enabled: false, remote: "origin" }),
    });
    folderKeyCache = new Map();
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(baseDir, { recursive: true, force: true });
  });

  it("survives a branch switch away and back (attribute on A, switch to B, switch back to A)", async () => {
    const textOnMain = "line one\nline two\nline three\n";
    await writeFile(docId, textOnMain);
    git(repoDir, ["add", "file.txt"]);
    git(repoDir, ["commit", "-q", "-m", "initial"]);

    // Attribute the whole file as AI-authored while on main, and persist it
    // under (repoRoot, "main") -- exactly what extension.ts's persistDoc
    // does after a live edit settles.
    engine.open(docId, textOnMain, [
      { startOffset: 0, endOffset: textOnMain.length, origin: "ai", tier: "2a", timestamp: Date.now() - 10_000 },
    ]);
    await persistDoc(docId, textOnMain);
    expect(originsOf(engine, docId)).toEqual([["ai", "2a"]]);

    // Switch to branch B. Content is unchanged (same commit), but the
    // (repoRoot, branch) key now resolves to "feature" -- a key with no
    // persisted history -- so the reconcile should show unmarked, not carry
    // over main's "ai" tag onto a branch that never had it.
    git(repoDir, ["checkout", "-q", "-b", "feature"]);
    await reconcile(textOnMain);
    expect(originsOf(engine, docId)).toEqual([["null", "null"]]);

    // Switch back to A. The bug: without folderKeyCache invalidation
    // (root cause #3) and without re-running restoreFor (root cause #2),
    // nothing would ever re-fetch main's persisted history here, and the
    // engine would keep whatever `reconcile` last set it to above --
    // permanently unmarked, i.e. the reported data loss.
    git(repoDir, ["checkout", "-q", "main"]);
    await reconcile(textOnMain);
    expect(originsOf(engine, docId)).toEqual([["ai", "2a"]]);
  });

  it("survives a stash push+pop round trip (no branch change at all)", async () => {
    const original = "alpha\nbeta\ngamma\n";
    await writeFile(docId, original);
    git(repoDir, ["add", "file.txt"]);
    git(repoDir, ["commit", "-q", "-m", "initial"]);

    // Attribute and persist the committed content under (repoRoot, "main").
    engine.open(docId, original, [
      { startOffset: 0, endOffset: original.length, origin: "ai", tier: "2a", timestamp: Date.now() - 10_000 },
    ]);
    await persistDoc(docId, original);

    // A human edit, saved to disk and persisted too, before stashing.
    const edited = "alpha\nbeta\nHUMAN EDIT\n";
    await writeFile(docId, edited);
    engine.pushChanges({
      docId,
      changes: [{ rangeOffset: original.length - "gamma\n".length, rangeLength: "gamma\n".length, text: "HUMAN EDIT\n" }],
      dirtyBefore: true,
      dirtyAfter: false,
      reason: "typed",
      timestamp: Date.now(),
    });
    await persistDoc(docId, edited);
    expect(originsOf(engine, docId).some(([origin]) => origin === "human")).toBe(true);

    // `git stash push` reverts the working tree to HEAD's committed
    // version -- same branch, no HEAD/branch-name change at all, so
    // BranchWatcher alone would never catch this.
    git(repoDir, ["stash", "push", "-q"]);
    const afterPush = await readFile(docId, "utf8");
    expect(afterPush).toBe(original);
    await reconcile(afterPush);
    expect(originsOf(engine, docId)).toEqual([["ai", "2a"]]);

    // `git stash pop` restores the edited (previously uncommitted) version.
    git(repoDir, ["stash", "pop", "-q"]);
    const afterPop = await readFile(docId, "utf8");
    expect(afterPop).toBe(edited);
    await reconcile(afterPop);
    expect(originsOf(engine, docId).some(([origin]) => origin === "human")).toBe(true);
    expect(originsOf(engine, docId).some(([origin]) => origin === "ai")).toBe(true);
  });

  it("does not worsen with repetition: a realistic same-line human/ai mix stays stable across two stash push+pop cycles (tourist-21)", async () => {
    // Two lines each mixing human-typed and ai-completed text *on the same
    // line* -- routine for a live per-keystroke engine (a human tweaking a
    // couple of characters inside an otherwise AI-written line), not a
    // contrived edge case. Human is the character-majority on both lines.
    const line1 = "const x = humanPart + aiPart1;\n"; // human: "const x = humanPart" (19), ai: rest (13)
    const line2 = "const y = moreHuman + aiPart2;\n"; // human: "const y = moreHuman" (19), ai: rest (13)
    const line3 = "done();\n";
    const original = line1 + line2 + line3;
    await writeFile(docId, original);
    git(repoDir, ["add", "file.txt"]);
    git(repoDir, ["commit", "-q", "-m", "initial"]);

    const h1End = "const x = humanPart".length;
    const a1End = line1.length;
    const h2Start = a1End;
    const h2End = a1End + "const y = moreHuman".length;
    const a2End = a1End + line2.length;
    const now = Date.now();
    engine.open(docId, original, [
      { startOffset: 0, endOffset: h1End, origin: "human", tier: null, timestamp: now - 10000 },
      { startOffset: h1End, endOffset: a1End, origin: "ai", tier: "2a", timestamp: now - 10000 },
      { startOffset: h2Start, endOffset: h2End, origin: "human", tier: null, timestamp: now - 9000 },
      { startOffset: h2End, endOffset: a2End, origin: "ai", tier: "2a", timestamp: now - 9000 },
      { startOffset: a2End, endOffset: original.length, origin: "human", tier: null, timestamp: now - 8000 },
    ]);
    await persistDoc(docId, original);

    // A human edit, dirty on disk, that will be stashed and popped repeatedly
    // (mirrors the live report: one already-attributed, still-open file,
    // round-tripped through `git stash` more than once).
    const edited = original + "// human comment\n";
    await writeFile(docId, edited);
    engine.pushChanges({
      docId,
      changes: [{ rangeOffset: original.length, rangeLength: 0, text: "// human comment\n" }],
      dirtyBefore: true,
      dirtyAfter: false,
      reason: "typed",
      timestamp: Date.now(),
    });
    await persistDoc(docId, edited);

    // The persisted schema is whole-line only (v1's locked scope), so a
    // same-line human/ai mix necessarily collapses to one origin per line on
    // any save/reload round trip -- that collapse itself isn't the bug.
    // Character-majority-per-line is the one deterministic, well-defined
    // choice for which origin a whole line collapses to; human is the
    // majority on both mixed lines here, so the correct, *stable* collapsed
    // result is 100% human, 0% ai for the original+edited content.
    const cyclePercentages: ReturnType<typeof percentagesOf>[] = [];
    for (let cycle = 0; cycle < 2; cycle++) {
      git(repoDir, ["stash", "push", "-q"]);
      const afterPush = await readFile(docId, "utf8");
      expect(afterPush).toBe(original);
      await reconcile(afterPush);
      await persistDoc(docId, afterPush);

      git(repoDir, ["stash", "pop", "-q"]);
      const afterPop = await readFile(docId, "utf8");
      expect(afterPop).toBe(edited);
      await reconcile(afterPop);
      await persistDoc(docId, afterPop);

      const stats = computeStats(engine.getRanges(docId));
      cyclePercentages.push(percentagesOf(stats));
    }

    // First cycle: no impossible/negative percentages, and the majority
    // (human) origin correctly wins the whole-line collapse.
    expect(cyclePercentages[0]).toEqual({ aiPct: 0, humanPct: 100, externalPct: 0 });
    // Second cycle: this is the assertion that catches the real bug -- with
    // the pre-fix code, each save independently hashed the *entire* line's
    // text for every sub-line range sharing it, so a human range and an ai
    // range on the same line produced identical `contentHash`es and
    // `upsertByContentHash` (store.ts) silently let whichever range was last
    // in save order clobber the other, non-deterministically, rather than
    // resolving to a stable winner -- so repeating the exact same stash
    // cycle could (and did, live) keep flipping/degrading the result instead
    // of settling.
    expect(cyclePercentages[1]).toEqual(cyclePercentages[0]);
  });

  // Regression for REVIEW_SENIOR.md's `folderKeyCache`/BranchWatcher-lag
  // finding: `folderKeyCache` used to be invalidated *only* by
  // BranchWatcher's callback, which per spike/FINDINGS.md Experiment 6 lags
  // the real git checkout by 1.2-3.3s+ -- longer than extension.ts's
  // SAVE_DEBOUNCE_MS (2000ms). If a debounced save fires in that window, it
  // reads whatever's still cached and persists the *new* branch's content
  // under the *old* branch's key -- polluting that branch's stored history
  // with content that was never actually seen on that branch, and that will
  // never validate against it again (dead weight until retention prunes it).
  // This test drives the exact same shared-cache pattern extension.ts uses
  // (see the `keyFor`/`restoreFor`/`persistDoc` helpers above) to prove the
  // pollution happens when nothing invalidates the cache before the save.
  it("without cache invalidation, a save that fires with the stale pre-checkout key writes the new branch's content into the old branch's store", async () => {
    const onMain = "line one\ntwo\nthree\n";
    await writeFile(docId, onMain);
    git(repoDir, ["add", "file.txt"]);
    git(repoDir, ["commit", "-q", "-m", "on main"]);

    engine.open(docId, onMain, [
      { startOffset: 0, endOffset: onMain.length, origin: "ai", tier: "2a", timestamp: Date.now() - 10_000 },
    ]);
    await persistDoc(docId, onMain); // persisted under key(repoRoot, "main")
    expect(folderKeyCache.get(repoDir)).toEqual({ repoRoot: repoDir, branch: "main" });

    const mainKey: RepoBranchKey = { repoRoot: repoDir, branch: "main" };
    const beforeBug = await persistence.listPersisted(mainKey);
    expect(beforeBug.find((d) => d.docId === docId)?.ranges).toHaveLength(1);

    git(repoDir, ["checkout", "-q", "-b", "feature"]);
    const onFeature = "totally different content on this branch\n";
    await writeFile(docId, onFeature);
    git(repoDir, ["add", "file.txt"]);
    git(repoDir, ["commit", "-q", "-m", "on feature"]);
    git(repoDir, ["checkout", "-q", "main"]);

    // The real trigger: switching to "feature" flips the working tree
    // instantly. `folderKeyCache` is untouched -- nothing has invalidated
    // it, exactly the pre-fix state right after `git checkout` but before
    // BranchWatcher's lagging callback runs.
    git(repoDir, ["checkout", "-q", "feature"]);
    const afterCheckout = await readFile(docId, "utf8");
    expect(afterCheckout).toBe(onFeature);
    expect(folderKeyCache.get(repoDir)).toEqual({ repoRoot: repoDir, branch: "main" }); // still stale

    // The debounced save fires using that stale cached key.
    engine.reload(docId, afterCheckout, [
      { startOffset: 0, endOffset: afterCheckout.length, origin: "external", tier: null, timestamp: Date.now() },
    ]);
    await persistDoc(docId, afterCheckout);

    // Pollution: "main"'s store now also holds an entry describing
    // "feature"'s content, even though this repo/workspace was never on
    // "main" with that content -- a stray entry that can only ever be dead
    // weight for "main" going forward.
    const afterBug = await persistence.listPersisted(mainKey);
    expect(afterBug.find((d) => d.docId === docId)?.ranges.length).toBeGreaterThan(1);
  });

  it("fix: invalidating the cache via reconcileAfterGitChange before the debounced save keeps each branch's content in its own store", async () => {
    const onMain = "line one\ntwo\nthree\n";
    await writeFile(docId, onMain);
    git(repoDir, ["add", "file.txt"]);
    git(repoDir, ["commit", "-q", "-m", "on main"]);

    engine.open(docId, onMain, [
      { startOffset: 0, endOffset: onMain.length, origin: "ai", tier: "2a", timestamp: Date.now() - 10_000 },
    ]);
    await persistDoc(docId, onMain);

    const mainKey: RepoBranchKey = { repoRoot: repoDir, branch: "main" };
    const featureKey: RepoBranchKey = { repoRoot: repoDir, branch: "feature" };

    git(repoDir, ["checkout", "-q", "-b", "feature"]);
    const onFeature = "totally different content on this branch\n";
    await writeFile(docId, onFeature);
    git(repoDir, ["add", "file.txt"]);
    git(repoDir, ["commit", "-q", "-m", "on feature"]);
    git(repoDir, ["checkout", "-q", "main"]);

    git(repoDir, ["checkout", "-q", "feature"]);
    const afterCheckout = await readFile(docId, "utf8");

    // The fix: extension.ts's disk-write handler now runs this exact
    // invalidate-then-restore sequence itself, synchronously with the
    // disk-write signal, instead of waiting on BranchWatcher -- so by the
    // time the debounced save fires below, the cache is already correct.
    await reconcile(afterCheckout);
    expect(folderKeyCache.get(repoDir)).toEqual({ repoRoot: repoDir, branch: "feature" });

    // Some attribution accrues for "feature"'s content by the time the
    // debounced save fires (a live edit, or -- as in the sibling "without
    // cache invalidation" test above -- whatever the engine assigns on
    // first seeing this content); the point under test is *which key* it
    // lands under, not what the attribution itself is.
    engine.reload(docId, afterCheckout, [
      { startOffset: 0, endOffset: afterCheckout.length, origin: "external", tier: null, timestamp: Date.now() },
    ]);
    await persistDoc(docId, afterCheckout);

    // "main"'s store is untouched by the branch switch: still exactly the
    // one entry it had before, no pollution from "feature"'s content.
    const mainAfter = await persistence.listPersisted(mainKey);
    expect(mainAfter.find((d) => d.docId === docId)?.ranges).toHaveLength(1);
    const mainRestored = await persistence.load(docId, "", mainKey, onMain);
    expect(mainRestored).toBeDefined();
    expect(mainRestored!.some((r) => r.origin === "ai")).toBe(true);

    // "feature"'s content was correctly persisted under its own key.
    const featureAfter = await persistence.listPersisted(featureKey);
    expect(featureAfter.find((d) => d.docId === docId)?.ranges).toHaveLength(1);
  });
});

describe("reconcileAfterGitChange (unit, fake deps)", () => {
  it("invalidates the shared folder key cache before restoring, so restore never sees a stale key", async () => {
    const folderKeyCache = new Map<string, RepoBranchKey>([["/repo", { repoRoot: "/repo", branch: "stale" }]]);
    const seenDuringRestore: (RepoBranchKey | undefined)[] = [];
    await reconcileAfterGitChange(
      {
        folderKeyCache,
        restore: async () => {
          seenDuringRestore.push(folderKeyCache.get("/repo"));
          return undefined;
        },
        reloadEngine: () => {},
      },
      ["/repo"],
      [{ docId: "/repo/a.ts", folderPath: "/repo", text: "hi" }]
    );
    expect(seenDuringRestore).toEqual([undefined]);
  });

  it("only reloads docs under an affected folder, leaving others untouched", async () => {
    const reloaded: string[] = [];
    await reconcileAfterGitChange(
      {
        folderKeyCache: new Map(),
        restore: async () => undefined,
        reloadEngine: (docId) => void reloaded.push(docId),
      },
      ["/repo-a"],
      [
        { docId: "/repo-a/a.ts", folderPath: "/repo-a", text: "" },
        { docId: "/repo-b/b.ts", folderPath: "/repo-b", text: "" },
      ]
    );
    expect(reloaded).toEqual(["/repo-a/a.ts"]);
  });
});

/**
 * The bug PR #11 claimed to fix but didn't: the disk-write handler in
 * extension.ts eagerly calls `reconcileAfterGitChange` instead of waiting on
 * BranchWatcher, but `resolveGitContext` -- what `restore` ultimately calls
 * through `keyFor`/`resolveKey` -- prefers a real `vscodeGitApi`'s
 * `repo.state.HEAD.name` whenever one is present (the actual production
 * case). That value itself lags the real `git checkout` on disk by
 * 1.2-3.5s (spike/FINDINGS.md Experiment 6), so calling `reconcileAfterGitChange`
 * sooner doesn't close the gap -- it just asks the same stale source
 * earlier. None of the tests above catch this because they construct
 * `RealPersistenceAdapter` with no `vscodeGitApi` at all, so `resolveGitContext`
 * always takes the raw-fs fallback -- never subject to this lag in the first
 * place. This block constructs a `vscodeGitApi` mock whose `state.HEAD.name`
 * is deliberately held stale after a real on-disk checkout, to reproduce the
 * race for real.
 */
describe("disk-write reload race against a lagging vscodeGitApi", () => {
  let repoDir: string;
  let baseDir: string;
  let docId: string;
  let engine: AttributionEngine;
  let mockHeadName: string;
  let gitApi: VscodeGitAPI;
  let persistence: RealPersistenceAdapter;
  let folderKeyCache: Map<string, RepoBranchKey>;

  function git(cwd: string, args: string[]): string {
    return execFileSync(
      "git",
      ["-c", "user.name=Tourist Test", "-c", "user.email=tourist-test@example.com", ...args],
      { cwd, encoding: "utf8" }
    ).trim();
  }

  // Mirrors extension.ts's *old*, buggy `restoreFor`: resolves the key via
  // `persistence.resolveKey`, which -- with a real `vscodeGitApi` present --
  // prefers `repo.state.HEAD.name` over the filesystem.
  async function restoreForLegacy(): Promise<{ key: RepoBranchKey; restored: Awaited<ReturnType<RealPersistenceAdapter["load"]>> }> {
    const key = await persistence.resolveKey({ fsPath: repoDir, toString: () => repoDir });
    folderKeyCache.set(repoDir, key);
    const text = await readFile(docId, "utf8");
    const restored = await persistence.load(docId, "", key, text);
    return { key, restored };
  }

  // Mirrors extension.ts's *fixed* `restoreForDiskWrite`: resolves the key
  // straight off `.git/HEAD` on disk, bypassing `vscodeGitApi` entirely,
  // regardless of what the mock's `state.HEAD.name` currently claims.
  async function restoreForDiskWrite(): Promise<{ key: RepoBranchKey; restored: Awaited<ReturnType<RealPersistenceAdapter["load"]>> }> {
    const key = (await resolveGitContextFallback(docId)) ?? { repoRoot: repoDir, branch: "(no-repo)" };
    folderKeyCache.set(repoDir, key);
    const text = await readFile(docId, "utf8");
    const restored = await persistence.load(docId, "", key, text);
    return { key, restored };
  }

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "tourist-git-reload-lag-repo-"));
    baseDir = await mkdtemp(join(tmpdir(), "tourist-git-reload-lag-store-"));
    git(repoDir, ["init", "-q", "-b", "main"]);
    docId = join(repoDir, "file.txt");
    folderKeyCache = new Map();

    // A real `vscode.git`-shaped API whose `state.HEAD.name` is a plain,
    // test-controlled variable rather than something that reacts to the
    // real `git checkout` calls below -- exactly the lag under test: the
    // real API only updates this asynchronously, well after the checkout
    // completes on disk.
    mockHeadName = "main";
    const repo: VscodeGitRepository = {
      rootUri: { fsPath: repoDir },
      state: {
        get HEAD() {
          return { name: mockHeadName };
        },
        onDidChange: () => ({ dispose: () => {} }),
      },
    };
    gitApi = {
      repositories: [repo],
      onDidOpenRepository: () => ({ dispose: () => {} }),
      getRepository: (uri) => (uri.fsPath.startsWith(repoDir) ? repo : null),
    };

    engine = new AttributionEngine({ corroborationStore: new CorroborationStore() });
    persistence = new RealPersistenceAdapter({
      baseDir,
      retentionDays: 30,
      vscodeGitApi: gitApi,
      getRepoRoots: () => [repoDir],
      gitNotesConfig: () => ({ enabled: false, remote: "origin" }),
    });
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(baseDir, { recursive: true, force: true });
  });

  it("legacy restore (through vscodeGitApi) still reads the stale pre-checkout branch -- reproduces the bug", async () => {
    const onMain = "line one\ntwo\nthree\n";
    await writeFile(docId, onMain);
    git(repoDir, ["add", "file.txt"]);
    git(repoDir, ["commit", "-q", "-m", "on main"]);
    engine.open(docId, onMain, [
      { startOffset: 0, endOffset: onMain.length, origin: "ai", tier: "2a", timestamp: Date.now() - 10_000 },
    ]);
    await persistence.save(docId, "", { repoRoot: repoDir, branch: "main" }, engine.getRanges(docId), onMain);

    git(repoDir, ["checkout", "-q", "-b", "feature"]);
    const onFeature = "totally different content on this branch\n";
    await writeFile(docId, onFeature);
    git(repoDir, ["add", "file.txt"]);
    git(repoDir, ["commit", "-q", "-m", "on feature"]);
    git(repoDir, ["checkout", "-q", "main"]);

    // The real checkout happens on disk right now -- `.git/HEAD` genuinely
    // points at "feature" -- but `mockHeadName` (standing in for the real
    // extension's lagging `repo.state.HEAD.name`) has NOT been updated yet,
    // exactly like the 1.2-3.5s window per spike/FINDINGS.md Experiment 6.
    git(repoDir, ["checkout", "-q", "feature"]);
    expect(await readFile(docId, "utf8")).toBe(onFeature);
    expect(mockHeadName).toBe("main"); // API hasn't caught up

    const { key } = await restoreForLegacy();
    // The bug: even though this restore ran *after* the real checkout, it
    // still resolves "main" -- calling reconcileAfterGitChange sooner never
    // helped, because the API it asks was always going to say "main" until
    // its own lag elapses.
    expect(key).toEqual({ repoRoot: repoDir, branch: "main" });
  });

  it("fix: restoreForDiskWrite resolves the real current branch despite the lagging vscodeGitApi", async () => {
    const onMain = "line one\ntwo\nthree\n";
    await writeFile(docId, onMain);
    git(repoDir, ["add", "file.txt"]);
    git(repoDir, ["commit", "-q", "-m", "on main"]);
    engine.open(docId, onMain, [
      { startOffset: 0, endOffset: onMain.length, origin: "ai", tier: "2a", timestamp: Date.now() - 10_000 },
    ]);
    await persistence.save(docId, "", { repoRoot: repoDir, branch: "main" }, engine.getRanges(docId), onMain);

    git(repoDir, ["checkout", "-q", "-b", "feature"]);
    const onFeature = "totally different content on this branch\n";
    await writeFile(docId, onFeature);
    git(repoDir, ["add", "file.txt"]);
    git(repoDir, ["commit", "-q", "-m", "on feature"]);
    git(repoDir, ["checkout", "-q", "main"]);

    // Same lag setup as above: real checkout on disk, mock API still stale.
    git(repoDir, ["checkout", "-q", "feature"]);
    expect(await readFile(docId, "utf8")).toBe(onFeature);
    expect(mockHeadName).toBe("main");

    // Confirm this doc genuinely has no persisted history under "feature"
    // yet, so a correct restore must come back undefined/unmarked here --
    // not "main"'s AI-attributed content.
    const { key, restored } = await restoreForDiskWrite();
    expect(key).toEqual({ repoRoot: repoDir, branch: "feature" });
    expect(restored).toBeUndefined();
    expect(folderKeyCache.get(repoDir)).toEqual({ repoRoot: repoDir, branch: "feature" });

    // Persist under the correctly-resolved "feature" key, then simulate the
    // API finally catching up (as it eventually does, 1.2-3.5s later) --
    // reconciling again afterwards must land on the exact same key, proving
    // the fix isn't a race against the API updating either.
    await persistence.save(docId, "", key, [{ startOffset: 0, endOffset: onFeature.length, origin: "external", tier: null, timestamp: Date.now() }], onFeature);
    mockHeadName = "feature";
    const afterApiCaughtUp = await restoreForDiskWrite();
    expect(afterApiCaughtUp.key).toEqual({ repoRoot: repoDir, branch: "feature" });
    expect(afterApiCaughtUp.restored?.some((r) => r.origin === "external")).toBe(true);

    // And "main"'s persisted history is untouched -- no pollution from the
    // race, matching the sibling suite's pollution-prevention assertions.
    const mainAfter = await persistence.listPersisted({ repoRoot: repoDir, branch: "main" });
    expect(mainAfter.find((d) => d.docId === docId)?.ranges).toHaveLength(1);
  });

  it("fix: reconcileAfterGitChange wired to restoreForDiskWrite reloads the engine with the correct branch's content, not the lagging API's", async () => {
    const onMain = "line one\ntwo\nthree\n";
    await writeFile(docId, onMain);
    git(repoDir, ["add", "file.txt"]);
    git(repoDir, ["commit", "-q", "-m", "on main"]);
    engine.open(docId, onMain, [
      { startOffset: 0, endOffset: onMain.length, origin: "ai", tier: "2a", timestamp: Date.now() - 10_000 },
    ]);
    await persistence.save(docId, "", { repoRoot: repoDir, branch: "main" }, engine.getRanges(docId), onMain);

    git(repoDir, ["checkout", "-q", "-b", "feature"]);
    const onFeature = "totally different content on this branch\n";
    await writeFile(docId, onFeature);
    git(repoDir, ["add", "file.txt"]);
    git(repoDir, ["commit", "-q", "-m", "on feature"]);
    git(repoDir, ["checkout", "-q", "main"]);
    git(repoDir, ["checkout", "-q", "feature"]);
    expect(mockHeadName).toBe("main"); // still lagging

    // Exactly the shape extension.ts's disk-write handler passes to
    // `reconcileAfterGitChange`, with `restore` wired to the fixed
    // `restoreForDiskWrite` instead of the legacy, API-preferring path.
    const snapshot: OpenDocSnapshot = { docId, folderPath: repoDir, text: onFeature };
    await reconcileAfterGitChange(
      {
        folderKeyCache,
        restore: async (id) => (await restoreForDiskWrite()).restored,
        reloadEngine: (id, text, restore) => void engine.reload(id, text, restore),
      },
      [repoDir],
      [snapshot]
    );

    // Correctly unmarked for "feature" (no persisted history there yet) --
    // not "main"'s carried-over "ai" attribution, which is what the
    // pre-fix, API-preferring restore would have produced.
    expect(engine.getRanges(docId).every((r) => r.origin === null)).toBe(true);
    expect(folderKeyCache.get(repoDir)).toEqual({ repoRoot: repoDir, branch: "feature" });
  });
});
