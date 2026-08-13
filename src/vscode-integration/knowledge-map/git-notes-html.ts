/**
 * Pure body-content builder for the Dashboard's "Git Notes Sync" tab (Phase 2
 * of UI_CONSOLIDATION_PLAN.md). Read-only status (mirrors settings.ts's
 * `gitNotesSync`/`gitNotesRemote`) plus Push/Fetch buttons that wrap the
 * *existing* `tourist.pushAttributionNotes`/`tourist.fetchAttributionNotes`
 * commands -- see panel.ts's `handleDashboardAction` for the wiring. No sync
 * logic lives here.
 */
export interface GitNotesViewState {
  enabled: boolean;
  remote: string;
  lastResult?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildGitNotesBodyHtml(state: GitNotesViewState): string {
  const badge = state.enabled
    ? `<span class="km-badge km-badge-ok">On</span>`
    : `<span class="km-badge km-badge-warn">Off</span>`;

  const lastResult = state.lastResult
    ? `<p class="km-hint">Last result: ${escapeHtml(state.lastResult)}</p>`
    : "";

  return `
    <section class="km-dashboard-panel">
      <h2>Git Notes Sync</h2>
      <p>${badge} <span class="km-hint">remote: <code>${escapeHtml(state.remote)}</code></span></p>
      <p class="km-hint">
        When on, Push/Fetch sync <code>refs/notes/tourist-attribution</code> with the remote above so a
        team can share attribution history. When off, notes stay entirely local -- no network calls of any
        kind. Toggle <code>tourist.gitNotesSync</code> in Settings to change this.
      </p>
      ${lastResult}
      <div class="km-dashboard-actions">
        <button type="button" data-action="pushNotes" ${state.enabled ? "" : "disabled"}>Push</button>
        <button type="button" data-action="fetchNotes" ${state.enabled ? "" : "disabled"}>Fetch</button>
      </div>
    </section>`;
}
