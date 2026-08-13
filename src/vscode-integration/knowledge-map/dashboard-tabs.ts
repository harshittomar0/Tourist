/**
 * Tab chrome for the "Tourist Dashboard" (Phase 2 of UI_CONSOLIDATION_PLAN.md
 * -- panel.ts generalized from a single-purpose Knowledge Map panel into a
 * tabbed dashboard). Kept in its own `vscode`-free module, same reasoning as
 * html.ts's own header comment: this is pure string/state logic, so it's
 * unit-testable the same way html.ts's transforms are (see
 * test/vscode-integration/dashboard-tabs.test.ts), unlike panel.ts itself.
 *
 * `injectDashboardChrome` is deliberately generic over *any* already-built
 * HTML document (the Knowledge Map tab's full `buildKnowledgeMapHtml` output,
 * or one of this file's own `buildStandaloneDashboardPage` docs for the other
 * two tabs) -- it only ever touches the `<body>`/`</body>` boundaries, never
 * anything CSP/nonce-related beyond nonce-tagging the one script it adds.
 */
import { makeNonce } from "./html.ts";

export type DashboardTab = "knowledge-map" | "hook-setup" | "git-notes";

export const DASHBOARD_TABS: ReadonlyArray<{ id: DashboardTab; label: string }> = [
  { id: "knowledge-map", label: "Knowledge Map" },
  { id: "hook-setup", label: "Hook Setup" },
  { id: "git-notes", label: "Git Notes Sync" },
];

export function isDashboardTab(value: unknown): value is DashboardTab {
  return typeof value === "string" && DASHBOARD_TABS.some((t) => t.id === value);
}

/**
 * Pure state transition for the `switchTab` webview message: returns the
 * requested tab if it's one of the three known ids, otherwise falls back to
 * `current` -- a malformed/stale postMessage (e.g. from a future tab id an
 * older extension build doesn't know about yet) degrades to "stay put"
 * rather than blanking the panel.
 */
export function nextDashboardTab(current: DashboardTab, requested: unknown): DashboardTab {
  return isDashboardTab(requested) ? requested : current;
}

function renderTabButton(tab: { id: DashboardTab; label: string }, activeTab: DashboardTab): string {
  const active = tab.id === activeTab;
  return `<button type="button" class="km-dashboard-tab${active ? " active" : ""}" data-tab="${tab.id}"${
    active ? ' aria-current="page"' : ""
  }>${tab.label}</button>`;
}

export function renderTabStrip(activeTab: DashboardTab): string {
  return `<nav class="km-dashboard-tabstrip">${DASHBOARD_TABS.map((t) => renderTabButton(t, activeTab)).join("")}</nav>`;
}

const TAB_STRIP_STYLE = `
  .km-dashboard-tabstrip { display: flex; gap: 4px; padding: 8px 12px; border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.3));
    font-family: var(--vscode-font-family); background: var(--vscode-editor-background); }
  .km-dashboard-tab { font-size: 12.5px; padding: 5px 12px; border-radius: 4px 4px 0 0; border: none; background: transparent;
    color: var(--vscode-foreground); opacity: 0.7; cursor: pointer; }
  .km-dashboard-tab:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
  .km-dashboard-tab.active { opacity: 1; background: var(--vscode-tab-activeBackground, var(--vscode-editor-background));
    border-bottom: 2px solid var(--vscode-focusBorder); font-weight: 600; }
`;

/**
 * Single script appended (once per rendered document) to wire both the tab
 * strip's clicks (-> `switchTab`) and any `[data-action]` buttons elsewhere
 * in the same document (-> `dashboardAction`, used by the Hook Setup/Git
 * Notes tabs' Install/Verify/Push/Fetch buttons). Guards `acquireVsCodeApi`
 * behind a `window`-level singleton because the Knowledge Map tab's own
 * bridge script (html.ts's buildOverrideBridgeSource) already calls it for
 * that document -- the VS Code webview API throws if acquired twice in the
 * same page, so both scripts share one instance via the same guard.
 */
const TAB_SWITCH_SCRIPT = `
(function () {
  var vscodeApi = window.__touristVscodeApi || (window.__touristVscodeApi = acquireVsCodeApi());
  document.querySelectorAll(".km-dashboard-tab[data-tab]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      vscodeApi.postMessage({ type: "switchTab", tab: btn.getAttribute("data-tab") });
    });
  });
  document.querySelectorAll("[data-action]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      if (btn.disabled) return;
      vscodeApi.postMessage({ type: "dashboardAction", action: btn.getAttribute("data-action") });
    });
  });
})();
`;

/**
 * Inserts the tab strip right after the opening `<body>` tag and appends a
 * nonce'd script (reusing the *given* nonce, not a freshly generated one --
 * see this module's header comment on why that has to match the document's
 * own CSP nonce) before `</body>`. Falls back to leaving `html` untouched if
 * neither anchor is found, matching html.ts's own defensive-anchor pattern.
 */
export function injectDashboardChrome(html: string, activeTab: DashboardTab, nonce: string): string {
  const chrome = `<style>${TAB_STRIP_STYLE}</style>${renderTabStrip(activeTab)}`;
  const withNav = /<body[^>]*>/.test(html) ? html.replace(/<body([^>]*)>/, `<body$1>${chrome}`) : html;
  const script = `<script nonce="${nonce}">${TAB_SWITCH_SCRIPT}</script>`;
  return withNav.includes("</body>") ? withNav.replace("</body>", `${script}\n</body>`) : withNav + script;
}

/**
 * Builds a full, self-contained HTML document for a dashboard tab that
 * isn't the Knowledge Map (which instead reuses `buildKnowledgeMapHtml` and
 * gets its chrome injected separately -- see panel.ts's `render`). Used for
 * the Hook Setup and Git Notes Sync tabs, whose content is a plain status
 * fragment rather than a pre-existing full document.
 */
export function buildStandaloneDashboardPage(bodyHtml: string, activeTab: DashboardTab, cspSource: string, extraStyle = ""): string {
  const nonce = makeNonce();
  const meta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">`;
  const doc = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
${meta}
<title>Tourist Dashboard</title>
<style>${extraStyle}</style>
</head>
<body>${bodyHtml}</body>
</html>`;
  return injectDashboardChrome(doc, activeTab, nonce);
}
