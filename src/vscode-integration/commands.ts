/**
 * Registers every `tourist.*` command from the Agent C brief: toggle
 * tracking, toggle markers, install/verify hook, a "fix line attribution"
 * equivalent, open the workspace view, and push/fetch attribution notes.
 *
 * Scope note on `fixLineAttribution`, flagged for the final report: GOAL1.md
 * §2's "Explicitly deferred out of v1" list cuts tourist-raw's *LLM-assisted*
 * "Fix Line Attribution" feature (intent-based reclassification of ambiguous
 * lines from recent prompts) entirely -- but the Agent C brief still lists
 * "fix-line-attribution equivalent" as a command to build. Read literally,
 * those two instructions conflict. This implements a non-LLM equivalent
 * instead: force a fresh whole-file-diff recompute of the active file
 * against the engine's resolved baseline, discarding any stale in-memory
 * tags -- i.e. "recompute this file's attribution now" rather than
 * "LLM-disambiguate ambiguous lines," so the command exists and does
 * something genuinely useful without resurrecting the deferred feature.
 * Confirm this reading is what was intended.
 */
import * as vscode from "vscode";
import { docIdFor } from "./change-listener.ts";
import type { EngineLike, PersistenceLike } from "./contracts.ts";
import { installHook, verifyHook } from "./hook-install.ts";
import * as settings from "./settings.ts";
import type { WorkspaceAttributionProvider } from "./workspace-view.ts";

export interface CommandDeps {
  extensionPath: string;
  engine: EngineLike;
  persistence: PersistenceLike;
  workspaceView: WorkspaceAttributionProvider;
  /** Re-renders decorations for every currently visible editor -- called
   * after anything that can change `AttributedRange[]` out from under an
   * open document (fix-line-attribution, a markers toggle). */
  refreshVisibleDecorations: () => void;
  refreshStatusBar: () => Promise<void>;
}

export function registerCommands(context: vscode.ExtensionContext, deps: CommandDeps): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("tourist.toggleTracking", async () => {
      const nowEnabled = !settings.isTrackingEnabled();
      await settings.setTrackingEnabled(nowEnabled);
      vscode.window.showInformationMessage(`Tourist: attribution tracking turned ${nowEnabled ? "on" : "off"}.`);
    }),

    vscode.commands.registerCommand("tourist.toggleMarkers", async () => {
      const nowShown = !settings.showAttributionMarkers();
      await settings.setShowAttributionMarkers(nowShown);
      vscode.window.showInformationMessage(`Tourist: attribution line markers ${nowShown ? "shown" : "hidden"}.`);
      deps.refreshVisibleDecorations();
    }),

    vscode.commands.registerCommand("tourist.installHook", () => installHook(deps.extensionPath)),
    vscode.commands.registerCommand("tourist.verifyHook", () => verifyHook(deps.extensionPath)),

    vscode.commands.registerCommand("tourist.fixLineAttribution", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.scheme !== "file") {
        vscode.window.showWarningMessage("Tourist: open a file first to recompute its attribution.");
        return;
      }
      const doc = editor.document;
      const docId = docIdFor(doc.uri);
      deps.engine.ingestWholeFileDiff({ docId, newContent: doc.getText(), timestamp: Date.now() });
      deps.refreshVisibleDecorations();
      await deps.refreshStatusBar();
      vscode.window.showInformationMessage("Tourist: recomputed attribution for the current file against its resolved baseline.");
    }),

    vscode.commands.registerCommand("tourist.openWorkspaceView", async () => {
      await deps.workspaceView.refresh();
      await vscode.commands.executeCommand("workbench.view.explorer");
    }),

    vscode.commands.registerCommand("tourist.pushAttributionNotes", async () => {
      if (!settings.isShareAttributionEnabled()) {
        vscode.window.showWarningMessage('Tourist: "Share Attribution" is off, so there is nothing to push. Enable tourist.shareAttribution first.');
        return;
      }
      const remote = settings.gitNotesRemote();
      await deps.persistence.pushNotes(remote);
      vscode.window.showInformationMessage(`Tourist: pushed attribution notes to "${remote}".`);
    }),

    vscode.commands.registerCommand("tourist.fetchAttributionNotes", async () => {
      if (!settings.isShareAttributionEnabled()) {
        vscode.window.showWarningMessage('Tourist: "Share Attribution" is off, so there is nothing to fetch. Enable tourist.shareAttribution first.');
        return;
      }
      const remote = settings.gitNotesRemote();
      await deps.persistence.fetchNotes(remote);
      await deps.workspaceView.refresh();
      vscode.window.showInformationMessage(`Tourist: fetched attribution notes from "${remote}".`);
    }),

    vscode.commands.registerCommand("tourist.openMenu", async () => {
      const tracking = settings.isTrackingEnabled();
      const markers = settings.showAttributionMarkers();
      const picked = await vscode.window.showQuickPick(
        [
          { label: "$(telescope) Attribution Tracking", description: tracking ? "On — click to turn off" : "Off — click to turn on", command: "tourist.toggleTracking" },
          { label: "$(telescope) Show Line Markers", description: markers ? "On — click to hide" : "Off — click to show", command: "tourist.toggleMarkers" },
          { label: "$(telescope) Fix Line Attribution", description: "Recompute the current file's attribution against its baseline", command: "tourist.fixLineAttribution" },
          { label: "$(telescope) Open Workspace Attribution View", description: "ai/human/external rollups across the whole workspace", command: "tourist.openWorkspaceView" },
          { label: "$(telescope) Install Claude Code Hook", description: "Required for Tier 1 attribution coverage", command: "tourist.installHook" },
          { label: "$(telescope) Verify Claude Code Hook", description: "Check the hook is actually registered", command: "tourist.verifyHook" },
          { label: "$(telescope) Push Attribution Notes", description: "Share local attribution history with a remote", command: "tourist.pushAttributionNotes" },
          { label: "$(telescope) Fetch Attribution Notes", description: "Pull shared attribution history from a remote", command: "tourist.fetchAttributionNotes" },
        ],
        { placeHolder: "Tourist" }
      );
      if (picked) await vscode.commands.executeCommand(picked.command);
    })
  );
}
