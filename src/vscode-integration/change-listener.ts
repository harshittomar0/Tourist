/**
 * Translates real `vscode.TextDocumentChangeEvent`s (and the open/save/close
 * lifecycle) into the plain `NormalizedChangeBatch` shape Agent A's engine
 * consumes (contract §1), plus the docId convention every module in this
 * directory shares.
 *
 * docId convention (Agent C's own concrete choice, since the contract only
 * says "a stable string key, not a raw vscode.Uri" without specifying the
 * exact string -- flagged in the final report): `doc.uri.fsPath`. Chosen
 * over `doc.uri.toString()` because Agent B's rename-notification contract
 * ("given an old and new document identity, re-key existing persisted
 * history") and the workspace-wide whole-file-diff path both operate on
 * real filesystem paths, so keying live-editing docIds the same way avoids
 * a second identity scheme existing solely on Agent C's side of the
 * boundary.
 */
import type * as vscode from "vscode";
import type { ChangeReason, NormalizedChange, NormalizedChangeBatch } from "./contracts.ts";

export function docIdFor(uri: vscode.Uri): string {
  return uri.fsPath;
}

/** vscode's own `TextDocumentContentChangeEvent` already carries
 * `rangeOffset`/`rangeLength`/`text` -- this is a pure reshape, not a
 * recomputation, so it can't introduce an offset bug of its own. */
export function toNormalizedChange(change: vscode.TextDocumentContentChangeEvent): NormalizedChange {
  return { rangeOffset: change.rangeOffset, rangeLength: change.rangeLength, text: change.text };
}

export function toChangeReason(reason: vscode.TextDocumentChangeReason | undefined, TextDocumentChangeReason: typeof vscode.TextDocumentChangeReason): ChangeReason {
  if (reason === TextDocumentChangeReason.Undo) return "undo";
  if (reason === TextDocumentChangeReason.Redo) return "redo";
  return "typed";
}

/**
 * `dirtyBefore` cannot be read off `event` itself -- by the time the event
 * fires, `document.isDirty` already reflects the *post*-edit state. Callers
 * must track the previous dirty flag themselves (see `DirtyTracker` below)
 * and pass it in explicitly; this function is the pure, testable reshape
 * once that's in hand.
 */
export function toNormalizedChangeBatch(
  event: Pick<vscode.TextDocumentChangeEvent, "document" | "contentChanges" | "reason">,
  dirtyBefore: boolean,
  TextDocumentChangeReason: typeof vscode.TextDocumentChangeReason,
  timestamp: number = Date.now()
): NormalizedChangeBatch | undefined {
  if (event.contentChanges.length === 0) return undefined;
  return {
    docId: docIdFor(event.document.uri),
    changes: event.contentChanges.map(toNormalizedChange),
    dirtyBefore,
    dirtyAfter: event.document.isDirty,
    reason: toChangeReason(event.reason, TextDocumentChangeReason),
    timestamp,
  };
}

/**
 * Tracks each open document's dirty flag across events, purely so
 * `toNormalizedChangeBatch` can be given a real `dirtyBefore` -- VS Code's
 * own event doesn't expose the pre-edit value. One instance per extension
 * activation, fed from the same open/change/close listeners `extension.ts`
 * already needs for engine lifecycle wiring.
 */
export class DirtyTracker {
  private readonly dirty = new Map<string, boolean>();

  onOpen(docId: string, isDirty: boolean): void {
    this.dirty.set(docId, isDirty);
  }

  onClose(docId: string): void {
    this.dirty.delete(docId);
  }

  /** Returns the dirty flag as of *before* this change, then updates it to `isDirtyNow`. */
  consume(docId: string, isDirtyNow: boolean): boolean {
    const before = this.dirty.get(docId) ?? false;
    this.dirty.set(docId, isDirtyNow);
    return before;
  }
}
