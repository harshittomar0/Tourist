/**
 * Pure body-content builder for the Dashboard's "Hook Setup" tab (Phase 2 of
 * UI_CONSOLIDATION_PLAN.md). Wraps the same install/verify status the
 * sidebar Status view shows (see status-html.ts's `hookRow`) with a fuller
 * explanation of what Tier 1 coverage means -- this tab is a persistent,
 * roomier view of the same underlying state, not new install/verify logic.
 */
export interface HookSetupViewState {
  scriptExists: boolean;
  installed: boolean;
  hookScriptPath: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const HOOK_SETUP_STYLE = `
  .km-dashboard-panel { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px 20px; max-width: 640px; }
  .km-dashboard-panel h2 { font-size: 15px; margin: 0 0 12px; }
  .km-dashboard-panel p { line-height: 1.5; opacity: 0.9; }
  .km-hint { opacity: 0.75; font-size: 12.5px; }
  .km-dashboard-panel code { background: var(--vscode-textCodeBlock-background); padding: 1px 5px; border-radius: 3px; }
  .km-dashboard-actions { display: flex; gap: 8px; margin-top: 14px; }
  .km-dashboard-actions button { font-size: 12px; padding: 5px 12px; border-radius: 4px; cursor: pointer;
    border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .km-dashboard-actions button:hover { background: var(--vscode-button-hoverBackground); }
  .km-badge { font-size: 11px; padding: 2px 8px; border-radius: 3px; }
  .km-badge-ok { background: var(--vscode-testing-iconPassed, #2ea043); color: #fff; }
  .km-badge-warn { background: var(--vscode-editorWarning-foreground, #cca700); color: #000; }
  .km-badge-error { background: var(--vscode-editorError-foreground, #f14c4c); color: #fff; }
`;

export function buildHookSetupBodyHtml(state: HookSetupViewState): string {
  const badge = !state.scriptExists
    ? `<span class="km-badge km-badge-error">Script missing</span>`
    : state.installed
      ? `<span class="km-badge km-badge-ok">Installed</span>`
      : `<span class="km-badge km-badge-warn">Not installed</span>`;

  return `
    <section class="km-dashboard-panel">
      <h2>Hook Setup</h2>
      <p>${badge}</p>
      <p class="km-hint">
        Tier 1 is Tourist's highest-confidence attribution: every line Claude Code edits through its
        PreToolUse/PostToolUse hooks is attributed with certainty, instead of being inferred from timing
        and process-corroboration heuristics (Tier 2/3). Installing the hook registers it in
        <code>~/.claude/settings.json</code> (or <code>$CLAUDE_CONFIG_DIR/settings.json</code> if set) --
        a new Claude Code session needs to start for it to take effect.
      </p>
      <p class="km-hint">Hook script: <code>${escapeHtml(state.hookScriptPath)}</code></p>
      <div class="km-dashboard-actions">
        <button type="button" data-action="installHook">Install</button>
        <button type="button" data-action="verifyHook">Verify</button>
      </div>
    </section>`;
}
