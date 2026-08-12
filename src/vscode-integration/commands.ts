/**
 * Registers every `tourist.*` command: toggle tracking, toggle markers,
 * install/verify hook, open the workspace view, and push/fetch attribution
 * notes.
 *
 * `fixLineAttribution` (a non-LLM "recompute this file" placeholder) has
 * been dropped entirely, per PLAN1.md's scope narrowing: Tier 3
 * ("external/unknown") already resolves at classification time the same
 * ambiguity tourist-raw's LLM-assisted feature existed to disambiguate after
 * the fact, so there is no equivalent leftover job for a command to do.
 */
import * as vscode from "vscode";
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

    vscode.commands.registerCommand("tourist.openWorkspaceView", async () => {
      await deps.workspaceView.refresh();
      await vscode.commands.executeCommand("workbench.view.explorer");
    }),

    vscode.commands.registerCommand("tourist.pushAttributionNotes", async () => {
      if (!settings.isGitNotesSyncEnabled()) {
        vscode.window.showWarningMessage('Tourist: "Git Notes Sync" is off, so there is nothing to push. Enable tourist.gitNotesSync first.');
        return;
      }
      const remote = settings.gitNotesRemote();
      await deps.persistence.pushNotes(remote);
      vscode.window.showInformationMessage(`Tourist: pushed attribution notes to "${remote}".`);
    }),

    vscode.commands.registerCommand("tourist.fetchAttributionNotes", async () => {
      if (!settings.isGitNotesSyncEnabled()) {
        vscode.window.showWarningMessage('Tourist: "Git Notes Sync" is off, so there is nothing to fetch. Enable tourist.gitNotesSync first.');
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
