/**
 * Singleton webview panel for the Knowledge Map, ported from tourist-raw's
 * src/webview/panel.ts lifecycle pattern (singleton `WebviewPanel`,
 * `retainContextWhenHidden: true`, re-render-in-place rather than recreate)
 * plus a CSP+nonce that tourist-raw's version didn't have -- added here
 * since this panel actually needs `enableScripts` for the injected bridge
 * (see html.ts), where tourist-raw's report panel had inline-script-free
 * static content.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { buildKnowledgeMapHtml } from "./html.ts";
import { resolveAnalyserPaths } from "./paths.ts";
import { applyOverride, loadForest, loadMergeForest, saveForest } from "./store.ts";
import type { WebviewToExtensionMessage } from "./types.ts";

export interface KnowledgeMapPanelDeps {
  /** Runs a deep-dive analyser pass on the given topic labels (delegates to
   * the same consent/backend/spawn flow as the "Generate Knowledge Map"
   * command -- see commands.ts's `runGenerateKnowledgeMap`). Resolves once
   * the CLI run has finished (or been reported as unavailable/failed) so
   * the panel knows when it's safe to re-render from disk. */
  onDeepDive: (topics: string[]) => Promise<void>;
}

let currentPanel: vscode.WebviewPanel | undefined;
let messageListener: vscode.Disposable | undefined;

export async function showKnowledgeMapPanel(context: vscode.ExtensionContext, deps: KnowledgeMapPanelDeps): Promise<void> {
  const paths = resolveAnalyserPaths(context.extensionPath);

  if (!fs.existsSync(paths.htmlPath)) {
    vscode.window.showErrorMessage(`Tourist: Knowledge Map UI not found at ${paths.htmlPath}.`);
    return;
  }

  if (!currentPanel) {
    currentPanel = vscode.window.createWebviewPanel(
      "touristKnowledgeMap",
      "Tourist: Knowledge Map",
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
  render(currentPanel, paths.htmlPath, paths.forestJsonPath);

  messageListener?.dispose();
  messageListener = currentPanel.webview.onDidReceiveMessage(async (message: WebviewToExtensionMessage) => {
    if (!currentPanel) return;

    if (message?.type === "nodeOverride") {
      const forest = loadForest(paths.forestJsonPath);
      const result = applyOverride(forest, message, merge);
      if (result.changed) {
        saveForest(paths.forestJsonPath, result.forest);
        render(currentPanel, paths.htmlPath, paths.forestJsonPath);
      }
      return;
    }

    if (message?.type === "deepDive") {
      if (!message.topics || message.topics.length === 0) return;
      await deps.onDeepDive(message.topics);
      render(currentPanel, paths.htmlPath, paths.forestJsonPath);
    }
  });
}

function render(panel: vscode.WebviewPanel, htmlPath: string, forestJsonPath: string): void {
  const rawHtml = fs.readFileSync(htmlPath, "utf8");
  const forest = loadForest(forestJsonPath);
  panel.webview.html = buildKnowledgeMapHtml(rawHtml, forest, panel.webview.cspSource);
}

/** Test-only seam: the module-level singleton means tests can't otherwise
 * observe/reset panel state between runs. Not called from extension.ts. */
export function _resetForTests(): void {
  currentPanel = undefined;
  messageListener = undefined;
}
