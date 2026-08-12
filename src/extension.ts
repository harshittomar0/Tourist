/**
 * Activation entry point (Agent C's sole integration point, per PLAN1.md
 * Part 2: "the 'seam' is a file, not a shared editing surface"). Wires the
 * document-change listener, decorations, status bar, workspace view,
 * commands, and settings in `src/vscode-integration/` to a real engine
 * (Agent A's `AttributionEngine`) and a real persistence adapter (wrapping
 * Agent B's `src/persistence/`).
 *
 * ============================ MOCK-TO-REAL SWAP, DONE ====================
 * Every consumer in this file talks to the `EngineLike`/`PersistenceLike`
 * *interfaces* (contracts.ts), never to a concrete implementation except
 * right here at construction. Both real implementations are now wired:
 *   - `AttributionEngine` (src/core/engine.ts) -- confirmed to implement
 *     `listTrackedDocIds` and (added during this consolidation pass)
 *     `renameDocument`.
 *   - `RealPersistenceAdapter` (persistence-adapter.ts) -- wraps Agent B's
 *     `PersistenceManager` + `src/persistence/gitNotes/*`; see that file's
 *     header comment for the real AttributedRange-shape mismatch it
 *     reconciles, and for the one still-unwired gap (writeNote/readNote have
 *     no real commit-time trigger yet).
 * ==========================================================================
 */
import { readFile as fsReadFile } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  FileHookLogReaderAdapter,
  NodeLockFileWatcherAdapter,
  PsListProcessScanFallbackAdapter,
  VscodeShellIntegrationBridgeAdapter,
  WorkspaceWatcherAdapter,
} from "./adapters/index.ts";
import { AttributionEngine } from "./core/engine.ts";
import { CorroborationStore } from "./core/corroboration-store.ts";
import { hashContent } from "./core/index.ts";
import { BranchWatcher } from "./persistence/index.ts";
import type { VscodeGitAPI, VscodeGitRepository } from "./persistence/vscodeGitTypes.ts";
import { registerCommands } from "./vscode-integration/commands.ts";
import { DirtyTracker, docIdFor, toNormalizedChangeBatch } from "./vscode-integration/change-listener.ts";
import type { AttributedRange, EngineLike, PersistenceLike, RepoBranchKey } from "./vscode-integration/contracts.ts";
import { refreshDecorations } from "./vscode-integration/decorations.ts";
import { resolveGitApi } from "./vscode-integration/git-extension.ts";
import { reconcileAfterGitChange, type OpenDocSnapshot } from "./vscode-integration/git-reload.ts";
import { registerKnowledgeMapCommands } from "./vscode-integration/knowledge-map/commands.ts";
import { RealPersistenceAdapter } from "./vscode-integration/persistence-adapter.ts";
import * as settings from "./vscode-integration/settings.ts";
import { StatusBarController } from "./vscode-integration/status-bar.ts";
import { WorkspaceAttributionProvider, type RollupNode } from "./vscode-integration/workspace-view.ts";

const SAVE_DEBOUNCE_MS = 2000;
/** How long a git-op-suppression window stays open after the last observed
 * git-repository state change -- ported from tourist-raw's own
 * GIT_ACTIVITY_SUPPRESS_MS pattern (watch for activity, suppress for a short
 * window after the most recent event, not just the instant of the event). */
const GIT_ACTIVITY_SUPPRESS_MS = 1500;

/** Longest-prefix match of `absolutePath` against the currently open
 * workspace folders -- the workspace identity every corroboration adapter
 * (lock-file/shell-integration/process-scan) keys its signals by, and so the
 * identity `resolveWorkspaceId`/git-op suppression must key by too, for the
 * corroboration-store lookup in tier-classification to ever actually hit. */
function workspaceRootForPath(absolutePath: string): string | undefined {
  const folders = vscode.workspace.workspaceFolders ?? [];
  let best: string | undefined;
  for (const folder of folders) {
    const root = folder.uri.fsPath;
    if (absolutePath === root || absolutePath.startsWith(root + path.sep)) {
      if (!best || root.length > best.length) best = root;
    }
  }
  return best;
}

/** Minimal test-only surface returned from `activate()` as extension
 * exports -- the E2E suite (test/e2e) has no other way to observe
 * in-memory engine state from outside the extension host, since
 * `vscode.TextEditor.setDecorations` has no public getter. Not used by any
 * production code path. */
export interface TouristTestApi {
  getAttributedRanges(docId: string): readonly AttributedRange[];
  /** The same `WorkspaceAttributionProvider` instance passed to
   * `vscode.window.createTreeView` below -- lets the E2E suite prove the
   * Explorer view has a real, populated data provider (not VS Code's
   * built-in "no data provider registered" fallback) without any public
   * API to inspect a contributed view's registration from outside. */
  getWorkspaceViewRootNodes(): readonly RollupNode[];
}

export function activate(context: vscode.ExtensionContext): TouristTestApi {
  let folderScopesSyncSnapshot: { path: string; key: RepoBranchKey }[] = [];

  const corroborationStore = new CorroborationStore();
  const hookScriptPath = path.join(context.extensionPath, "hooks", "attribution-hook.mjs");
  const hookLogReader = new FileHookLogReaderAdapter(hookScriptPath);
  const realEngine = new AttributionEngine({
    corroborationStore,
    hookLogReader,
    resolveWorkspaceId: (docId) => workspaceRootForPath(docId) ?? docId,
  });
  const engine: EngineLike = realEngine;

  // `vscode.Extension.exports` is a getter that throws (not returns
  // undefined) if read before that extension finishes activating -- a real
  // race with `vscode.git`'s own `*` activation event when Tourist itself
  // activates earlier via its contributed view's auto-added
  // `onView:tourist.workspaceAttribution` event. `resolveGitApi` catches
  // that throw so a slow-to-activate git extension degrades to "no git
  // integration this session" instead of crashing all of `activate()`.
  const gitApi: VscodeGitAPI | undefined = resolveGitApi<VscodeGitAPI>(
    (id) => vscode.extensions.getExtension(id),
    "vscode.git",
    1
  );
  const persistence: PersistenceLike = new RealPersistenceAdapter({
    baseDir: vscode.Uri.joinPath(context.globalStorageUri, "attribution").fsPath,
    retentionDays: settings.attributionRetentionDays(),
    vscodeGitApi: gitApi,
    gitNotesConfig: () => ({ enabled: settings.isGitNotesSyncEnabled(), remote: settings.gitNotesRemote() }),
    getRepoRoots: () => [...new Set(folderScopesSyncSnapshot.map((f) => f.key.repoRoot))],
  });

  // ---- Tier 2a/2b/2c corroboration adapters ---------------------------
  // Each adapter emits `(workspaceRoot, signal)` into the shared
  // corroboration store; tier-classification (src/core/tier-classifier.ts)
  // reads that store keyed by `workspaceRootForPath`'s same identity.
  const lockFileWatcher = new NodeLockFileWatcherAdapter();
  const shellIntegrationBridge = new VscodeShellIntegrationBridgeAdapter();
  const processScanFallback = new PsListProcessScanFallbackAdapter();
  for (const adapter of [lockFileWatcher, shellIntegrationBridge, processScanFallback]) {
    adapter.onDidChangeSignal((workspaceRoot, signal) => corroborationStore.setSignal(workspaceRoot, signal));
  }
  // Started once, with the workspace folders open at activation time -- a
  // folder added later via onDidChangeWorkspaceFolders won't gain Tier
  // 2a/2b/2c coverage without a window reload. Restarting these on every
  // folder change would require each adapter to support being re-started
  // without leaking its previous fs.watch/setInterval handle, which none of
  // them do today; fixing that is a follow-up, not required to make the
  // core feature work end-to-end.
  const initialWorkspaceRoots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  lockFileWatcher.start(initialWorkspaceRoots);
  shellIntegrationBridge.start(initialWorkspaceRoots);
  processScanFallback.start(initialWorkspaceRoots);

  // ---- Whole-file-diff ingestion for tracked-but-closed files ----------
  const workspaceWatcherAdapter = new WorkspaceWatcherAdapter(realEngine, {
    readFile: async (absolutePath) => {
      try {
        return await fsReadFile(absolutePath, "utf8");
      } catch {
        return null;
      }
    },
    isDocumentOpen: (absolutePath) =>
      vscode.workspace.textDocuments.some((d) => d.uri.scheme === "file" && d.uri.fsPath === absolutePath),
  });
  const workspaceWatcherDisposables = new Map<string, { dispose(): void }>();
  function startWatchingFolder(folder: vscode.WorkspaceFolder): void {
    const root = folder.uri.fsPath;
    if (workspaceWatcherDisposables.has(root)) return;
    workspaceWatcherDisposables.set(root, workspaceWatcherAdapter.watch(root, settings.exclusionPolicyOverride()));
  }
  function stopWatchingFolder(root: string): void {
    workspaceWatcherDisposables.get(root)?.dispose();
    workspaceWatcherDisposables.delete(root);
  }
  for (const folder of vscode.workspace.workspaceFolders ?? []) startWatchingFolder(folder);

  // ---- Git-op suppression ----------------------------------------------
  // Ported from tourist-raw's git-guard-and-reconcile pattern: any observed
  // git-repository state change (checkout/rebase/stash/merge/commit, etc.,
  // via the real vscode.git extension's Repository.state.onDidChange) opens
  // a short suppression window per affected workspace folder, so a disk
  // write the operation causes lands as unmarked (null) instead of being
  // misattributed "ai"/"external".
  const gitSuppressTimers = new Map<string, ReturnType<typeof setTimeout>>();
  function markGitActivity(workspaceRoot: string): void {
    realEngine.setGitOpSuppression(workspaceRoot, true);
    const existing = gitSuppressTimers.get(workspaceRoot);
    if (existing) clearTimeout(existing);
    gitSuppressTimers.set(
      workspaceRoot,
      setTimeout(() => {
        gitSuppressTimers.delete(workspaceRoot);
        realEngine.setGitOpSuppression(workspaceRoot, false);
      }, GIT_ACTIVITY_SUPPRESS_MS)
    );
  }
  function suppressForRepo(repo: VscodeGitRepository): void {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const root = folder.uri.fsPath;
      if (root === repo.rootUri.fsPath || root.startsWith(repo.rootUri.fsPath + path.sep)) {
        markGitActivity(root);
      }
    }
  }
  if (gitApi) {
    const attachRepo = (repo: VscodeGitRepository): void => {
      context.subscriptions.push(repo.state.onDidChange(() => suppressForRepo(repo)));
    };
    for (const repo of gitApi.repositories) attachRepo(repo);
    context.subscriptions.push(gitApi.onDidOpenRepository(attachRepo));
  }

  const dirtyTracker = new DirtyTracker();
  const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const folderKeyCache = new Map<string, RepoBranchKey>();

  async function keyFor(folder: vscode.WorkspaceFolder): Promise<RepoBranchKey> {
    const cached = folderKeyCache.get(folder.uri.fsPath);
    if (cached) return cached;
    const key = await persistence.resolveKey(folder.uri);
    folderKeyCache.set(folder.uri.fsPath, key);
    return key;
  }

  async function folderScopes(): Promise<{ path: string; key: RepoBranchKey }[]> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    return Promise.all(folders.map(async (f) => ({ path: f.uri.fsPath, key: await keyFor(f) })));
  }

  // Converts a live docId's character-offset ranges into line units for the
  // rollup, when that docId has a real open document to convert offsets
  // with (REVIEW_SENIOR.md finding #5 -- see attribution-rollup.ts's
  // `getDocument` doc comment for why this matters).
  const getOpenDocument = (docId: string): vscode.TextDocument | undefined =>
    vscode.workspace.textDocuments.find((d) => d.uri.scheme === "file" && d.uri.fsPath === docId);

  const workspaceView = new WorkspaceAttributionProvider(() => ({
    engine,
    persistence,
    getDocument: getOpenDocument,
    // ---- SWAP POINT: pass Agent A's real ExclusionPredicate.isTracked
    // here once it exists, per contract §1c -- the UI must reuse it rather
    // than reimplement exclusion logic. This closure reads a cached
    // snapshot rather than resolving folder keys itself; `refreshWorkspaceState`
    // below always awaits `folderScopes()` first so the cache is warm
    // before `refresh()` is called.
    folders: folderScopesSyncSnapshot,
  }));

  const statusBar = new StatusBarController(() => ({
    engine,
    persistence,
    getDocument: getOpenDocument,
    folders: folderScopesSyncSnapshot,
  }));
  context.subscriptions.push(statusBar);

  const treeView = vscode.window.createTreeView("tourist.workspaceAttribution", { treeDataProvider: workspaceView });
  context.subscriptions.push(treeView);

  async function refreshWorkspaceState(): Promise<void> {
    folderScopesSyncSnapshot = await folderScopes();
    await Promise.all([workspaceView.refresh(), statusBar.refresh()]);
  }

  function refreshEditorDecorations(editor: vscode.TextEditor): void {
    if (editor.document.uri.scheme !== "file") return;
    const ranges = engine.getRanges(docIdFor(editor.document.uri));
    refreshDecorations(editor, ranges, settings.showAttributionMarkers());
  }

  function refreshVisibleDecorations(): void {
    for (const editor of vscode.window.visibleTextEditors) refreshEditorDecorations(editor);
  }

  async function restoreFor(doc: vscode.TextDocument): Promise<AttributedRange[] | undefined> {
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    if (!folder) return undefined;
    const key = await keyFor(folder);
    const text = doc.getText();
    return persistence.load(docIdFor(doc.uri), simpleHash(text), key, text);
  }

  async function persistDoc(doc: vscode.TextDocument): Promise<void> {
    if (doc.uri.scheme !== "file" || !settings.isTrackingEnabled()) return;
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    if (!folder) return;
    const key = await keyFor(folder);
    const docId = docIdFor(doc.uri);
    const text = doc.getText();
    await persistence.save(docId, simpleHash(text), key, engine.getRanges(docId), text);
  }

  function scheduleSave(doc: vscode.TextDocument): void {
    if (doc.uri.scheme !== "file") return;
    const key = doc.uri.fsPath;
    const existing = saveTimers.get(key);
    if (existing) clearTimeout(existing);
    saveTimers.set(
      key,
      setTimeout(() => {
        saveTimers.delete(key);
        void persistDoc(doc).then(() => void statusBar.refresh());
      }, SAVE_DEBOUNCE_MS)
    );
  }

  function flushPendingSaves(): void {
    for (const timer of saveTimers.values()) clearTimeout(timer);
    saveTimers.clear();
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme === "file") void persistDoc(doc);
    }
  }

  async function openDoc(doc: vscode.TextDocument): Promise<void> {
    if (doc.uri.scheme !== "file") return;
    const docId = docIdFor(doc.uri);
    const restore = await restoreFor(doc);
    engine.open(docId, doc.getText(), restore);
    dirtyTracker.onOpen(docId, doc.isDirty);
  }

  // ---- Git-caused reload (branch switch / stash pop data-loss fix) ----
  // `restoreFor` above only ever runs once, at onDidOpenTextDocument time --
  // nothing re-invokes it when a still-open document's on-disk content
  // changes because of a git operation (checkout, stash pop, ...) rather
  // than a live edit, and `folderKeyCache` (below) never invalidates on a
  // branch change either, so a save/load after switching branches can
  // silently keep using the previous branch's (repoRoot, branch) key. Both
  // are closed by re-running `restoreFor` (through a fresh key) and
  // `engine.reload` for the affected open document(s) -- see
  // `git-reload.ts`'s header comment for why that sequencing lives there
  // instead of inline here.
  function openDocSnapshotsUnder(folderPaths: readonly string[]): {
    snapshots: OpenDocSnapshot[];
    docsById: Map<string, vscode.TextDocument>;
  } {
    const snapshots: OpenDocSnapshot[] = [];
    const docsById = new Map<string, vscode.TextDocument>();
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme !== "file" || doc.isDirty) continue;
      const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
      if (!folder || !folderPaths.includes(folder.uri.fsPath)) continue;
      const docId = docIdFor(doc.uri);
      snapshots.push({ docId, folderPath: folder.uri.fsPath, text: doc.getText() });
      docsById.set(docId, doc);
    }
    return { snapshots, docsById };
  }

  async function reloadAfterGitChange(affectedFolderPaths: readonly string[]): Promise<void> {
    const { snapshots, docsById } = openDocSnapshotsUnder(affectedFolderPaths);
    await reconcileAfterGitChange(
      {
        folderKeyCache,
        restore: (docId) => restoreFor(docsById.get(docId)!),
        reloadEngine: (docId, text, restore) => void engine.reload(docId, text, restore),
      },
      affectedFolderPaths,
      snapshots
    );
    for (const editor of vscode.window.visibleTextEditors) {
      if (docsById.has(docIdFor(editor.document.uri))) refreshEditorDecorations(editor);
    }
    await refreshWorkspaceState();
  }

  // BranchWatcher reuses the *same* `gitApi` repositories already tracked
  // for git-op suppression above -- diffs `repo.state.HEAD` (debounced) and
  // only calls back on a real branch change, per its own doc comment.
  const branchWatcher = new BranchWatcher();
  if (gitApi) {
    branchWatcher.watchVscodeGitApi(gitApi, (change) => {
      const affected = (vscode.workspace.workspaceFolders ?? [])
        .map((f) => f.uri.fsPath)
        .filter((root) => root === change.repoRoot || root.startsWith(change.repoRoot + path.sep));
      if (affected.length) void reloadAfterGitChange(affected);
    });
  }
  context.subscriptions.push(branchWatcher);

  // ---- Initial activation state --------------------------------------
  void (async () => {
    folderScopesSyncSnapshot = await folderScopes();
    for (const doc of vscode.workspace.textDocuments) await openDoc(doc);
    refreshVisibleDecorations();
    await refreshWorkspaceState();
  })();

  // ---- Document lifecycle --------------------------------------------
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(async (doc) => {
      await openDoc(doc);
      for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document === doc) refreshEditorDecorations(editor);
      }
    }),

    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc.uri.scheme !== "file") return;
      const docId = docIdFor(doc.uri);
      void persistDoc(doc);
      engine.close(docId);
      dirtyTracker.onClose(docId);
    }),

    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.scheme !== "file") return;
      engine.save(docIdFor(doc.uri));
      void persistDoc(doc).then(() => void statusBar.refresh());
    }),

    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.scheme !== "file") return;
      const docId = docIdFor(event.document.uri);
      const dirtyBefore = dirtyTracker.consume(docId, event.document.isDirty);
      const batch = toNormalizedChangeBatch(event, dirtyBefore, vscode.TextDocumentChangeReason);
      if (!batch || !settings.isTrackingEnabled()) return;
      engine.pushChanges(batch);
      scheduleSave(event.document);
      for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document === event.document) refreshEditorDecorations(editor);
      }

      // A clean-before-and-after change during an active git-op suppression
      // window (see `markGitActivity` above) can only be git reverting this
      // document's on-disk content -- a stash pop, rebase, or any other git
      // op that isn't a branch change (BranchWatcher above already handles
      // those). Re-fetch persisted, content-hash-keyed attribution for the
      // *new* content instead of leaving it as whatever `pushChanges` just
      // (correctly) left unmarked. Excludes a hook-confirmed tier-1 write --
      // a real, just-verified Claude Code edit racing the same suppression
      // window is not a git revert, and reloading over it would blow away
      // attribution persistence hasn't caught up to yet (it saves on a
      // debounce), the same tier-1 carve-out `reclassifyRecentDiskWrites`
      // (engine.ts, tourist-18's fix) makes for the identical reason.
      const isDiskWrite = !batch.dirtyBefore && !batch.dirtyAfter;
      const workspaceRoot = workspaceRootForPath(event.document.uri.fsPath);
      if (isDiskWrite && workspaceRoot && gitSuppressTimers.has(workspaceRoot)) {
        const isHookConfirmedWrite = hookLogReader.matchesContent(docId, hashContent(event.document.getText()));
        if (!isHookConfirmedWrite) {
          void reloadAfterGitChange([workspaceRoot]).then(() => void statusBar.refresh());
        }
      }
    }),

    vscode.workspace.onDidRenameFiles(async (event) => {
      for (const { oldUri, newUri } of event.files) {
        const oldDocId = docIdFor(oldUri);
        const newDocId = docIdFor(newUri);
        const folder = vscode.workspace.getWorkspaceFolder(newUri);
        if (folder) {
          const key = await keyFor(folder);
          await persistence.rename(oldDocId, newDocId, key);
        }
        // Real rename entry point on the engine (added during this
        // consolidation, replacing the close+reopen workaround): moves live
        // in-memory state -- ranges, undo/redo history, snapshot baseline --
        // to the new docId in place, rather than losing anything not
        // captured in a hand-carried ranges snapshot.
        engine.renameDocument(oldDocId, newDocId);
      }
      await refreshWorkspaceState();
    }),

    vscode.window.onDidChangeVisibleTextEditors(async (editors) => {
      for (const editor of editors) await openDoc(editor.document);
      for (const editor of editors) refreshEditorDecorations(editor);
    }),

    vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      for (const folder of event.added) startWatchingFolder(folder);
      for (const folder of event.removed) stopWatchingFolder(folder.uri.fsPath);
      void refreshWorkspaceState();
    }),

    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!settings.affectsTouristConfig(event)) return;
      refreshVisibleDecorations();
      void statusBar.refresh();
    }),

    // Flush any pending debounced saves so nothing's lost when the window closes.
    new vscode.Disposable(() => flushPendingSaves()),

    hookLogReader,
    lockFileWatcher,
    shellIntegrationBridge,
    processScanFallback,
    new vscode.Disposable(() => {
      for (const timer of gitSuppressTimers.values()) clearTimeout(timer);
      gitSuppressTimers.clear();
      for (const disposable of workspaceWatcherDisposables.values()) disposable.dispose();
      workspaceWatcherDisposables.clear();
      workspaceWatcherAdapter.dispose();
    })
  );

  registerCommands(context, {
    engine,
    persistence,
    workspaceView,
    hookInstaller: hookLogReader,
    hookScriptPath,
    refreshVisibleDecorations,
    refreshStatusBar: () => statusBar.refresh(),
  });

  registerKnowledgeMapCommands(context);

  return {
    getAttributedRanges: (docId: string) => engine.getRanges(docId),
    getWorkspaceViewRootNodes: () => workspaceView.getChildren(),
  };
}

export function deactivate(): void {}

/** Placeholder content-hash for the mock persistence boundary -- Agent B's
 * real module owns the actual hashing scheme (src/core/hash.ts already
 * exists for the engine's own internal use; whether persistence reuses that
 * exact function or its own is Agent B's call, not pinned by the contract
 * text). Not cryptographic; only needs stable equality for "does this
 * content match what was last saved." */
function simpleHash(content: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}
