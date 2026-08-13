/**
 * `tourist.status` sidebar Webview View provider (Phase 1 of
 * UI_CONSOLIDATION_PLAN.md) -- lives in the same "Tourist" Activity Bar
 * container as the moved `tourist.workspaceAttribution` tree view (Phase 0).
 *
 * This is pure glue: every button in status-html.ts's rendered HTML posts a
 * `{ type: "action", action }` message, and `handleAction` below maps that
 * straight onto an *already-registered* `tourist.*` command via
 * `vscode.commands.executeCommand`. No business logic is duplicated here --
 * see commands.ts and hook-install.ts for what each command actually does.
 *
 * Like commands.ts, panel.ts, and every other file here that
 * `import * as vscode from "vscode"`, this module isn't unit-testable
 * outside the extension host -- see knowledge-map-package-json.test.ts's
 * header comment for why, and status-html.ts's own tests for the pure logic
 * extracted out of this file so it *can* be tested.
 */
import * as vscode from "vscode";
import type { HookInstaller } from "./hook-install.ts";
import { verifyHookState } from "./hook-install.ts";
import * as settings from "./settings.ts";
import { buildStatusHtml } from "./status-html.ts";

export interface StatusViewDeps {
  hookInstaller: HookInstaller;
  hookScriptPath: string;
}

const ACTION_COMMANDS: Record<string, string> = {
  toggleTracking: "tourist.toggleTracking",
  toggleMarkers: "tourist.toggleMarkers",
  installHook: "tourist.installHook",
  verifyHook: "tourist.verifyHook",
  pushNotes: "tourist.pushAttributionNotes",
  fetchNotes: "tourist.fetchAttributionNotes",
  generateKnowledgeMap: "tourist.generateKnowledgeMap",
  openDashboard: "tourist.showKnowledgeMap",
};

interface StatusViewMessage {
  type?: string;
  action?: string;
}

export class TouristStatusViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "tourist.status";

  private view: vscode.WebviewView | undefined;

  constructor(private readonly deps: StatusViewDeps) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };

    webviewView.webview.onDidReceiveMessage(async (message: StatusViewMessage) => {
      if (message?.type !== "action" || !message.action) return;
      const commandId = ACTION_COMMANDS[message.action];
      if (!commandId) {
        vscode.window.showErrorMessage(`Tourist: unrecognized status view action "${message.action}".`);
        return;
      }
      // VS Code's webview message API does not surface a rejected promise
      // from this callback anywhere -- an uncaught throw/rejection from the
      // dispatched command would otherwise leave the user with a click that
      // silently "does nothing" (the same class of bug already fixed in
      // panel.ts's onDidReceiveMessage). Catch everything and report it
      // explicitly.
      try {
        await vscode.commands.executeCommand(commandId);
        await this.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Tourist: ${message.action} failed: ${(err as Error).message ?? String(err)}`);
      }
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) void this.refresh();
    });
    webviewView.onDidDispose(() => {
      if (this.view === webviewView) this.view = undefined;
    });

    void this.refresh();
  }

  async refresh(): Promise<void> {
    const view = this.view;
    if (!view) return;
    const hook = await verifyHookState(this.deps.hookInstaller, this.deps.hookScriptPath);
    view.webview.html = buildStatusHtml(
      {
        trackingEnabled: settings.isTrackingEnabled(),
        markersShown: settings.showAttributionMarkers(),
        hookScriptExists: hook.scriptExists,
        hookInstalled: hook.installed,
        gitNotesSyncEnabled: settings.isGitNotesSyncEnabled(),
        gitNotesRemote: settings.gitNotesRemote(),
        knowledgeMapEnabled: settings.isKnowledgeMapEnabled(),
      },
      view.webview.cspSource
    );
  }
}
