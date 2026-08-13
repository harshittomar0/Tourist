/**
 * Pure HTML builder for the `tourist.status` sidebar Webview View (Phase 1
 * of UI_CONSOLIDATION_PLAN.md). Kept free of any `vscode` import -- unlike
 * status-view.ts, which owns the actual `WebviewViewProvider` glue -- so it
 * can be unit tested the same way knowledge-map/html.ts is (see that
 * module's header comment and test/vscode-integration/knowledge-map-html.test.ts
 * for the established pattern this file follows).
 *
 * Every button here posts `{ type: "action", action: <id> }` back to
 * status-view.ts, which dispatches each `action` to an *existing*
 * `tourist.*` command via `vscode.commands.executeCommand` -- no new
 * business logic lives in this file or in status-view.ts, per the plan's
 * Phase 1 constraint.
 */
import { makeNonce } from "./knowledge-map/html.ts";

export interface StatusViewState {
  trackingEnabled: boolean;
  markersShown: boolean;
  hookScriptExists: boolean;
  hookInstalled: boolean;
  gitNotesSyncEnabled: boolean;
  gitNotesRemote: string;
  knowledgeMapEnabled: boolean;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function toggleRow(label: string, on: boolean, action: string): string {
  return `
    <div class="row">
      <span class="row-label">${label}</span>
      <button type="button" class="toggle ${on ? "on" : "off"}" data-action="${action}" role="switch" aria-checked="${on}">
        ${on ? "On" : "Off"}
      </button>
    </div>`;
}

function hookRow(state: StatusViewState): string {
  const badge = !state.hookScriptExists
    ? `<span class="badge badge-error">Script missing</span>`
    : state.hookInstalled
      ? `<span class="badge badge-ok">Installed</span>`
      : `<span class="badge badge-warn">Not installed</span>`;
  return `
    <div class="row">
      <span class="row-label">Claude Code Hook</span>
      ${badge}
    </div>
    <div class="row-actions">
      <button type="button" data-action="installHook">Install</button>
      <button type="button" data-action="verifyHook">Verify</button>
    </div>`;
}

function gitNotesRow(state: StatusViewState): string {
  const status = state.gitNotesSyncEnabled
    ? `<span class="badge badge-ok">On</span> <span class="row-hint">remote: ${escapeHtml(state.gitNotesRemote)}</span>`
    : `<span class="badge badge-warn">Off</span>`;
  return `
    <div class="row">
      <span class="row-label">Git Notes Sync</span>
      ${status}
    </div>
    <div class="row-actions">
      <button type="button" data-action="pushNotes" ${state.gitNotesSyncEnabled ? "" : "disabled"}>Push</button>
      <button type="button" data-action="fetchNotes" ${state.gitNotesSyncEnabled ? "" : "disabled"}>Fetch</button>
    </div>`;
}

function knowledgeMapRow(state: StatusViewState): string {
  const status = state.knowledgeMapEnabled
    ? `<span class="badge badge-ok">Enabled</span>`
    : `<span class="badge badge-warn">Disabled</span>`;
  return `
    <div class="row">
      <span class="row-label">Knowledge Map</span>
      ${status}
    </div>
    <div class="row-actions">
      <button type="button" data-action="generateKnowledgeMap" ${state.knowledgeMapEnabled ? "" : "disabled"}>Generate</button>
      <button type="button" data-action="openDashboard">Open Dashboard</button>
    </div>`;
}

const STYLE = `
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); font-size: 12.5px; padding: 8px 10px; }
  h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.75; margin: 14px 0 6px; }
  h3:first-of-type { margin-top: 2px; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 3px 0; }
  .row-label { opacity: 0.9; }
  .row-hint { opacity: 0.7; font-size: 11px; }
  .row-actions { display: flex; gap: 6px; padding: 2px 0 8px; }
  button { font-size: 11.5px; padding: 3px 8px; border-radius: 4px; border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; }
  button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
  button:disabled { opacity: 0.5; cursor: default; }
  button.toggle.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .badge { font-size: 11px; padding: 1px 6px; border-radius: 3px; }
  .badge-ok { background: var(--vscode-testing-iconPassed, #2ea043); color: #fff; }
  .badge-warn { background: var(--vscode-editorWarning-foreground, #cca700); color: #000; }
  .badge-error { background: var(--vscode-editorError-foreground, #f14c4c); color: #fff; }
  .footer { margin-top: 16px; padding-top: 8px; border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.3)); }
  .footer a { color: var(--vscode-textLink-foreground); text-decoration: none; cursor: pointer; }
  .footer a:hover { text-decoration: underline; }
`;

const SCRIPT = `
(function () {
  var vscodeApi = acquireVsCodeApi();
  document.querySelectorAll("[data-action]").forEach(function (el) {
    el.addEventListener("click", function () {
      if (el.disabled) return;
      vscodeApi.postMessage({ type: "action", action: el.getAttribute("data-action") });
    });
  });
})();
`;

export function buildStatusHtml(state: StatusViewState, cspSource: string): string {
  const nonce = makeNonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>Tourist Status</title>
<style>${STYLE}</style>
</head>
<body>
  <h3>Attribution</h3>
  ${toggleRow("Tracking", state.trackingEnabled, "toggleTracking")}
  ${toggleRow("Show Line Markers", state.markersShown, "toggleMarkers")}

  <h3>Hook</h3>
  ${hookRow(state)}

  <h3>Git Notes</h3>
  ${gitNotesRow(state)}

  <h3>Knowledge Map</h3>
  ${knowledgeMapRow(state)}

  <div class="footer">
    <a data-action="openDashboard">Open Tourist Dashboard →</a>
  </div>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}
