/**
 * Singleton webview panel for the "Tourist Dashboard" (Phase 2 of
 * UI_CONSOLIDATION_PLAN.md) -- generalized from a Knowledge-Map-only panel
 * into a tabbed dashboard, reusing (not rewriting) the same lifecycle
 * pattern ported from tourist-raw's src/webview/panel.ts: singleton
 * `WebviewPanel`, `retainContextWhenHidden: true`, re-render-in-place, plus
 * this project's own CSP+nonce addition.
 *
 * Three tabs (dashboard-tabs.ts's `DASHBOARD_TABS`):
 *  - "knowledge-map": exactly today's content, unchanged -- html.ts's
 *    `buildKnowledgeMapHtml`, store.ts's forest load/save, `onDeepDive`/
 *    `onReopen`. The only addition is dashboard-tabs.ts's chrome injected
 *    around the same full document.
 *  - "hook-setup"/"git-notes": thin, read-only status views (hook-setup-html.ts/
 *    git-notes-html.ts) whose buttons dispatch to *existing* commands via
 *    `handleDashboardAction` below -- no new install/verify/push/fetch logic.
 *
 * `showDashboardPanel`'s `initialTab` lets a caller (knowledge-map/commands.ts's
 * `tourist.showKnowledgeMap`) always land on a specific tab, even when the
 * panel is already open on a different one.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { HookInstaller } from "../hook-install.ts";
import { verifyHookState } from "../hook-install.ts";
import * as settings from "../settings.ts";
import { buildStandaloneDashboardPage, injectDashboardChrome, nextDashboardTab, type DashboardTab } from "./dashboard-tabs.ts";
import { buildGitNotesBodyHtml } from "./git-notes-html.ts";
import { buildKnowledgeMapHtml, makeNonce } from "./html.ts";
import { buildHookSetupBodyHtml, HOOK_SETUP_STYLE } from "./hook-setup-html.ts";
import { resolveAnalyserPaths, type AnalyserPaths } from "./paths.ts";
import { applyOverride, loadForest, loadMergeForest, saveForest } from "./store.ts";
import { emptyForest } from "./types.ts";
import type { ForestFile, WebviewToExtensionMessage } from "./types.ts";

export interface DashboardPanelDeps {
  /** Runs a deep-dive analyser pass on the given topic labels (delegates to
   * the same consent/backend/spawn flow as the "Generate Knowledge Map"
   * command -- see commands.ts's `runGenerateKnowledgeMap`). Resolves once
   * the CLI run has finished (or been reported as unavailable/failed) so
   * the panel knows when it's safe to re-render from disk. */
  onDeepDive: (topics: string[]) => Promise<void>;
  /** Runs a single-node re-review analyser pass (delegates to the same
   * consent/backend/spawn flow, via `--reopen` -- see commands.ts's
   * `runGenerateKnowledgeMap` and html.ts's "Re-review" affordance).
   * Resolves once the CLI run has finished, same as `onDeepDive`. */
  onReopen: (topic: string) => Promise<void>;
  /** Read-only status source for the Hook Setup tab -- the same
   * `FileHookLogReaderAdapter` instance wired everywhere else in this
   * extension (see hook-install.ts's header comment). Installing/verifying
   * from the tab goes through the existing `tourist.installHook`/
   * `tourist.verifyHook` commands (see `handleDashboardAction`), not this
   * directly -- it's only read here to render current status. */
  hookInstaller: HookInstaller;
  hookScriptPath: string;
}

/** Backwards-compatible alias -- the plan generalizes this panel into the
 * Dashboard, but callers/tests that still think in "Knowledge Map panel"
 * terms shouldn't need to rename on top of everything else moving. */
export type KnowledgeMapPanelDeps = DashboardPanelDeps;

let currentPanel: vscode.WebviewPanel | undefined;
let messageListener: vscode.Disposable | undefined;
let currentTab: DashboardTab = "knowledge-map";
/** Last theme reported by the webview's themeSelect (see html.ts's bridge
 * script) -- threaded into every subsequent Knowledge Map render so
 * switching tabs or round-tripping a nodeOverride/deepDive doesn't silently
 * reset the user's live theme choice back to the raw file's hardcoded
 * default. */
let currentTheme: string | undefined;

export async function showDashboardPanel(
  context: vscode.ExtensionContext,
  deps: DashboardPanelDeps,
  initialTab: DashboardTab = "knowledge-map"
): Promise<void> {
  const paths = resolveAnalyserPaths(context.extensionPath);
  currentTab = initialTab;

  if (!currentPanel) {
    currentPanel = vscode.window.createWebviewPanel(
      "touristDashboard",
      "Tourist Dashboard",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(path.dirname(paths.htmlPath))],
      }
    );
    currentPanel.onDidDispose(() => {
      currentPanel = undefined;
      messageListener?.dispose();
      messageListener = undefined;
    });
  } else {
    currentPanel.reveal(vscode.ViewColumn.Beside);
  }

  const merge = await loadMergeForest(paths.analyserDir);
  await render(currentPanel, paths, deps);

  messageListener?.dispose();
  messageListener = currentPanel.webview.onDidReceiveMessage(async (message: WebviewToExtensionMessage) => {
    if (!currentPanel) return;

    // VS Code's webview message API does not surface a rejected promise
    // from this callback anywhere -- an uncaught throw here (e.g.
    // saveForest's unguarded fs.writeFileSync hitting a full disk or a
    // permissions error) would otherwise leave the user with a click that
    // silently "does nothing." Catch everything and report it explicitly.
    try {
      if (message?.type === "themeChanged") {
        currentTheme = message.theme;
        return;
      }

      if (message?.type === "switchTab") {
        currentTab = nextDashboardTab(currentTab, message.tab);
        await render(currentPanel, paths, deps);
        return;
      }

      if (message?.type === "dashboardAction") {
        await handleDashboardAction(message.action);
        await render(currentPanel, paths, deps);
        return;
      }

      if (message?.type === "nodeOverride") {
        const forest = loadForest(paths.forestJsonPath);
        const result = applyOverride(forest, message, merge);
        if (result.error) {
          vscode.window.showWarningMessage(`Tourist: ${result.error}`);
          return;
        }
        if (result.changed) {
          saveForest(paths.forestJsonPath, result.forest);
          await render(currentPanel, paths, deps);
        }
        return;
      }

      if (message?.type === "deepDive") {
        if (!message.topics || message.topics.length === 0) return;
        await deps.onDeepDive(message.topics);
        await render(currentPanel, paths, deps);
        return;
      }

      if (message?.type === "reopenNode") {
        if (!message.topic) return;
        await deps.onReopen(message.topic);
        await render(currentPanel, paths, deps);
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Tourist: Knowledge Map action failed: ${(err as Error).message}`);
    }
  });
}

/** Backwards-compatible alias for `showDashboardPanel` -- see
 * `KnowledgeMapPanelDeps`'s doc comment. Always opens on the Knowledge Map
 * tab, matching this function's pre-Phase-2 behavior. */
export async function showKnowledgeMapPanel(context: vscode.ExtensionContext, deps: DashboardPanelDeps): Promise<void> {
  await showDashboardPanel(context, deps, "knowledge-map");
}

/**
 * Maps a Hook Setup/Git Notes Sync tab button's `dashboardAction` straight
 * onto an already-registered `tourist.*` command -- see commands.ts and
 * hook-install.ts for what each one actually does. No business logic is
 * duplicated here.
 */
async function handleDashboardAction(action: unknown): Promise<void> {
  switch (action) {
    case "installHook":
      await vscode.commands.executeCommand("tourist.installHook");
      return;
    case "verifyHook":
      await vscode.commands.executeCommand("tourist.verifyHook");
      return;
    case "pushNotes":
      await vscode.commands.executeCommand("tourist.pushAttributionNotes");
      return;
    case "fetchNotes":
      await vscode.commands.executeCommand("tourist.fetchAttributionNotes");
      return;
    case "generateKnowledgeMap":
      await vscode.commands.executeCommand("tourist.generateKnowledgeMap");
      return;
    default:
      return;
  }
}

async function render(panel: vscode.WebviewPanel, paths: AnalyserPaths, deps: DashboardPanelDeps): Promise<void> {
  if (currentTab === "hook-setup") {
    const hookState = await verifyHookState(deps.hookInstaller, deps.hookScriptPath);
    const body = buildHookSetupBodyHtml({ ...hookState, hookScriptPath: deps.hookScriptPath });
    panel.webview.html = buildStandaloneDashboardPage(body, currentTab, panel.webview.cspSource, HOOK_SETUP_STYLE);
    return;
  }

  if (currentTab === "git-notes") {
    const body = buildGitNotesBodyHtml({
      enabled: settings.isGitNotesSyncEnabled(),
      remote: settings.gitNotesRemote(),
    });
    panel.webview.html = buildStandaloneDashboardPage(body, currentTab, panel.webview.cspSource, HOOK_SETUP_STYLE);
    return;
  }

  if (!fs.existsSync(paths.htmlPath)) {
    const body = `<section class="km-dashboard-panel"><h2>Knowledge Map</h2><p>Tourist: Knowledge Map UI not found at <code>${paths.htmlPath}</code>.</p></section>`;
    panel.webview.html = buildStandaloneDashboardPage(body, currentTab, panel.webview.cspSource, HOOK_SETUP_STYLE);
    return;
  }

  const rawHtml = fs.readFileSync(paths.htmlPath, "utf8");
  const forest = loadForestOrWarn(paths.forestJsonPath);
  const nonce = makeNonce();
  const html = buildKnowledgeMapHtml(rawHtml, forest, panel.webview.cspSource, currentTheme, nonce);
  panel.webview.html = injectDashboardChrome(html, currentTab, nonce);
}

/** `loadForest` throws when `forestJsonPath` exists but failed to parse (see
 * store.ts) -- a real problem distinct from "no forest.json yet". `render`
 * runs both on initial panel open and after every webview action, so rather
 * than aborting the whole panel over a corrupted file, this surfaces a
 * one-time warning and falls back to an empty forest for display purposes
 * only (the corrupted file on disk is left untouched -- nothing here saves
 * over it). */
function loadForestOrWarn(forestJsonPath: string): ForestFile {
  try {
    return loadForest(forestJsonPath);
  } catch (err) {
    vscode.window.showWarningMessage(
      `Tourist: couldn't read your knowledge map data (${(err as Error).message}). Showing an empty map instead of overwriting anything.`
    );
    return emptyForest();
  }
}

/** Test-only seam: the module-level singleton means tests can't otherwise
 * observe/reset panel state between runs. Not called from extension.ts. */
export function _resetForTests(): void {
  currentPanel = undefined;
  messageListener = undefined;
  currentTheme = undefined;
  currentTab = "knowledge-map";
}
