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
