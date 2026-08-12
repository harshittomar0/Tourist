/**
 * Activation entry point (Agent C's sole integration point, per PLAN1.md
 * Part 2: "the 'seam' is a file, not a shared editing surface"). Wires the
 * document-change listener, decorations, status bar, workspace view,
 * commands, and settings in `src/vscode-integration/` to an engine and a
 * persistence module.
 *
 * ============================ MOCK-TO-REAL SWAP =========================
 * Both dependencies below are currently the hand-written mocks from
 * `src/vscode-integration/mocks/`, per the brief: Agent C builds and
 * validates against these first, independent of Agents A/B's real modules.
 * Every consumer in this file talks to the `EngineLike`/`PersistenceLike`
 * *interfaces* (contracts.ts), never to `MockAttributionEngine`/
 * `MockPersistence` concretely except right here at construction -- so the
 * swap at Sync point 1/2 is meant to be exactly these two constructor
 * calls, once:
 *   - Agent A's real engine additionally implements `listTrackedDocIds`
 *     (flagged gap, see contracts.ts)
 *   - Agent B's real persistence module additionally implements
 *     `listPersisted` (flagged gap, see contracts.ts)
 * Everything else in this file is written against the interface today
 * specifically so that becomes true.
 * ==========================================================================
 */
import * as vscode from "vscode";
import { registerCommands } from "./vscode-integration/commands.ts";
import { DirtyTracker, docIdFor, toNormalizedChangeBatch } from "./vscode-integration/change-listener.ts";
import type { AttributedRange, EngineLike, PersistenceLike, RepoBranchKey } from "./vscode-integration/contracts.ts";
import { refreshDecorations } from "./vscode-integration/decorations.ts";
import { MockAttributionEngine } from "./vscode-integration/mocks/mock-engine.ts";
import { MockPersistence } from "./vscode-integration/mocks/mock-persistence.ts";
import * as settings from "./vscode-integration/settings.ts";
import { StatusBarController } from "./vscode-integration/status-bar.ts";
import { WorkspaceAttributionProvider } from "./vscode-integration/workspace-view.ts";

const SAVE_DEBOUNCE_MS = 2000;

export function activate(context: vscode.ExtensionContext): void {
  // ---- MOCK-TO-REAL SWAP POINT: construct the real engine/persistence
  // modules here instead, once Agents A/B clear their own exit criteria.
  const engine: EngineLike = new MockAttributionEngine();
  const persistence: PersistenceLike = new MockPersistence({ shareAttributionEnabled: settings.isShareAttributionEnabled() });

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

  let folderScopesSyncSnapshot: { path: string; key: RepoBranchKey }[] = [];

  const workspaceView = new WorkspaceAttributionProvider(() => ({
    engine,
    persistence,
    // ---- SWAP POINT: pass Agent A's real ExclusionPredicate.isTracked
    // here once it exists, per contract §1c -- the UI must reuse it rather
    // than reimplement exclusion logic. This closure reads a cached
    // snapshot rather than resolving folder keys itself; `refreshWorkspaceState`
    // below always awaits `folderScopes()` first so the cache is warm
    // before `refresh()` is called.
    folders: folderScopesSyncSnapshot,
  }));

  const statusBar = new StatusBarController(() => ({ engine, persistence, folders: folderScopesSyncSnapshot }));
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
    const contentHash = simpleHash(doc.getText());
    return persistence.load(docIdFor(doc.uri), contentHash, key);
  }

  async function persistDoc(doc: vscode.TextDocument): Promise<void> {
    if (doc.uri.scheme !== "file" || !settings.isTrackingEnabled()) return;
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    if (!folder) return;
    const key = await keyFor(folder);
    const docId = docIdFor(doc.uri);
    await persistence.save(docId, simpleHash(doc.getText()), key, engine.getRanges(docId));
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
    }),

    vscode.workspace.onDidRenameFiles(async (event) => {
      for (const { oldUri, newUri } of event.files) {
        const oldDocId = docIdFor(oldUri);
        const newDocId = docIdFor(newUri);
        await persistence.rename(oldDocId, newDocId);
        // ---- Contract gap flagged in the final report: EngineLike (§2)
        // exposes no rename entry point at all, even though the real
        // engine keeps in-memory state keyed by docId exactly like
        // persistence does -- a rename would silently orphan it the same
        // way GOAL1.md calls out as tourist-raw's own bug otherwise.
        // Interim mechanical workaround until Agent A adds a real
        // `rename` method: carry the current ranges over by hand via
        // close+reopen, seeding the new docId with the old one's state.
        const ranges = engine.getRanges(oldDocId);
        engine.close(oldDocId);
        if (ranges.length > 0) {
          const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === newUri.fsPath);
          if (doc) engine.open(newDocId, doc.getText(), ranges);
        }
      }
      await refreshWorkspaceState();
    }),

    vscode.window.onDidChangeVisibleTextEditors(async (editors) => {
      for (const editor of editors) await openDoc(editor.document);
      for (const editor of editors) refreshEditorDecorations(editor);
    }),

    vscode.workspace.onDidChangeWorkspaceFolders(() => void refreshWorkspaceState()),

    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!settings.affectsTouristConfig(event)) return;
      refreshVisibleDecorations();
      void statusBar.refresh();
    }),

    // Flush any pending debounced saves so nothing's lost when the window closes.
    new vscode.Disposable(() => flushPendingSaves())
  );

  registerCommands(context, {
    extensionPath: context.extensionPath,
    engine,
    persistence,
    workspaceView,
    refreshVisibleDecorations,
    refreshStatusBar: () => statusBar.refresh(),
  });
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
