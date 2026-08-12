import * as vscode from "vscode";
import { createExclusionPredicate, type ExclusionPredicate } from "../core/exclusion.ts";
import type { AttributionEngine } from "../core/engine.ts";
import type { Disposable } from "../core/types.ts";

/**
 * The workspace-wide file-system watcher adapter that drives the
 * whole-file-diff ingestion path (Phase 1, per the always-on/workspace-wide
 * tracking decision). Has no Phase 0 dependency -- built on well-documented
 * `vscode.workspace.createFileSystemWatcher` behavior, not an open research
 * question -- but its *performance* characteristics on large repositories
 * are validated later, in Phase 4's benchmark, not assumed correct here.
 *
 * A thin `RawWatcher` seam separates "how do we get told about file
 * changes" from "what do we do about it", so this adapter's own logic
 * (exclusion filtering, skip-if-open-document, feeding the engine) can be
 * unit-tested with a fake watcher instead of a real VS Code workspace.
 */
export interface RawWatcher extends Disposable {
  onDidCreate(listener: (absolutePath: string) => void): Disposable;
  onDidChange(listener: (absolutePath: string) => void): Disposable;
  /** Deletion is intentionally not wired into attribution here: what
   * happens to a deleted file's history is Agent B's (persistence) call,
   * not Agent A's -- this adapter only drives whole-file-diff ingestion for
   * files that still exist to be diffed. */
  onDidDelete(listener: (absolutePath: string) => void): Disposable;
}

export function createVscodeRawWatcher(workspaceRoot: string): RawWatcher {
  const pattern = new vscode.RelativePattern(vscode.Uri.file(workspaceRoot), "**/*");
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);
  return {
    onDidCreate: (listener) => watcher.onDidCreate((uri) => listener(uri.fsPath)),
    onDidChange: (listener) => watcher.onDidChange((uri) => listener(uri.fsPath)),
    onDidDelete: (listener) => watcher.onDidDelete((uri) => listener(uri.fsPath)),
    dispose: () => watcher.dispose(),
  };
}

export interface WorkspaceWatcherDeps {
  /** Defaults to the real vscode-backed watcher; overridable for tests. */
  createWatcher?: (workspaceRoot: string) => RawWatcher;
  readFile: (absolutePath: string) => Promise<string | null>;
  /** True if `absolutePath` currently has an open vscode.TextDocument --
   * the live-editing path (Agent C's document-change listener) already
   * covers those, so this adapter must not also diff them, or the same
   * edit could be double-counted through two ingestion paths at once. */
  isDocumentOpen: (absolutePath: string) => boolean;
  /** Maps an absolute path to the engine's document-identity scheme.
   * Defaults to the identity function. */
  toDocId?: (absolutePath: string) => string;
}

export class WorkspaceWatcherAdapter {
  private readonly predicates = new Map<string, ExclusionPredicate>();
  private readonly disposables: Disposable[] = [];

  constructor(private readonly engine: AttributionEngine, private readonly deps: WorkspaceWatcherDeps) {}

  /** Starts watching `workspaceRoot`. Exclusion filtering happens *before*
   * a change is ever handled (contract §1c: "A file outside this predicate
   * is never snapshotted, diffed, watched, or attributed") -- note the
   * predicate is still evaluated per-event here rather than narrowing the
   * underlying glob itself, since `vscode.RelativePattern` globs can't
   * express arbitrary .gitignore semantics; this is "filtered before ever
   * being *processed*", the practically-equivalent guarantee. */
  watch(workspaceRoot: string): Disposable {
    const predicate = createExclusionPredicate(workspaceRoot);
    this.predicates.set(workspaceRoot, predicate);

    const watcher = (this.deps.createWatcher ?? createVscodeRawWatcher)(workspaceRoot);
    const handle = (absolutePath: string): void => {
      void this.handleChange(predicate, absolutePath);
    };

    const d1 = watcher.onDidCreate(handle);
    const d2 = watcher.onDidChange(handle);
    const disposable: Disposable = {
      dispose: () => {
        d1.dispose();
        d2.dispose();
        watcher.dispose();
        this.predicates.delete(workspaceRoot);
      },
    };
    this.disposables.push(disposable);
    return disposable;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }

  private async handleChange(predicate: ExclusionPredicate, absolutePath: string): Promise<void> {
    if (!predicate.isTracked(absolutePath)) return;
    if (this.deps.isDocumentOpen(absolutePath)) return;

    const newContent = await this.deps.readFile(absolutePath);
    if (newContent === null) return; // unreadable/deleted between event and read

    const docId = (this.deps.toDocId ?? ((p: string) => p))(absolutePath);
    this.engine.ingestWholeFileDiff({ docId, newContent, timestamp: Date.now() });
  }
}
