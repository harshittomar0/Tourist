import { describe, expect, it } from "vitest";
import { buildStatusHtml, type StatusViewState } from "../../src/vscode-integration/status-html.ts";

function sampleState(overrides: Partial<StatusViewState> = {}): StatusViewState {
  return {
    trackingEnabled: true,
    markersShown: true,
    hookScriptExists: true,
    hookInstalled: true,
    gitNotesSyncEnabled: false,
    gitNotesRemote: "origin",
    knowledgeMapEnabled: false,
    ...overrides,
  };
}

describe("buildStatusHtml", () => {
  it("wraps a CSP meta tag and a matching nonce'd script", () => {
    const html = buildStatusHtml(sampleState(), "vscode-webview://source");
    const nonceMatch = html.match(/script-src 'nonce-([^']+)'/);
    expect(nonceMatch).not.toBeNull();
    expect(html).toContain(`<script nonce="${nonceMatch![1]}">`);
  });

  it("reflects tracking/markers toggle state via data-action buttons", () => {
    const on = buildStatusHtml(sampleState({ trackingEnabled: true, markersShown: false }), "src");
    expect(on).toMatch(/toggle on" data-action="toggleTracking"/);
    expect(on).toMatch(/toggle off" data-action="toggleMarkers"/);
  });

  it("shows an installed badge and no error badge when the hook is installed", () => {
    const html = buildStatusHtml(sampleState({ hookScriptExists: true, hookInstalled: true }), "src");
    expect(html).toContain('class="badge badge-ok"');
    expect(html).not.toContain('class="badge badge-error"');
    expect(html).toContain('data-action="installHook"');
    expect(html).toContain('data-action="verifyHook"');
  });

  it("shows an error badge when the hook script itself is missing", () => {
    const html = buildStatusHtml(sampleState({ hookScriptExists: false, hookInstalled: false }), "src");
    expect(html).toContain('class="badge badge-error"');
    expect(html).toContain("Script missing");
  });

  it("shows a warn badge when the script exists but isn't installed", () => {
    const html = buildStatusHtml(sampleState({ hookScriptExists: true, hookInstalled: false }), "src");
    expect(html).toContain('class="badge badge-warn"');
    expect(html).toContain("Not installed");
  });

  it("disables Push/Fetch when git notes sync is off, enables + shows remote when on", () => {
    const off = buildStatusHtml(sampleState({ gitNotesSyncEnabled: false }), "src");
    expect(off).toMatch(/data-action="pushNotes" disabled/);
    expect(off).toMatch(/data-action="fetchNotes" disabled/);

    const on = buildStatusHtml(sampleState({ gitNotesSyncEnabled: true, gitNotesRemote: "upstream" }), "src");
    expect(on).not.toMatch(/data-action="pushNotes" disabled/);
    expect(on).toContain("upstream");
  });

  it("escapes the git notes remote name to avoid breaking out of markup", () => {
    const html = buildStatusHtml(sampleState({ gitNotesSyncEnabled: true, gitNotesRemote: '"><img>' }), "src");
    expect(html).not.toContain('"><img>');
    expect(html).toContain("&quot;&gt;&lt;img&gt;");
  });

  it("disables Generate when Knowledge Map is disabled, but Open Dashboard always stays enabled", () => {
    const disabled = buildStatusHtml(sampleState({ knowledgeMapEnabled: false }), "src");
    expect(disabled).toMatch(/data-action="generateKnowledgeMap" disabled/);
    expect(disabled).not.toMatch(/data-action="openDashboard"[^>]*disabled/);

    const enabled = buildStatusHtml(sampleState({ knowledgeMapEnabled: true }), "src");
    expect(enabled).not.toMatch(/data-action="generateKnowledgeMap" disabled/);
  });

  it("includes a footer link that dispatches openDashboard", () => {
    const html = buildStatusHtml(sampleState(), "src");
    expect(html).toContain('data-action="openDashboard"');
    expect(html).toContain("Open Tourist Dashboard");
  });

  it("wires every [data-action] button to postMessage via the bridge script", () => {
    const html = buildStatusHtml(sampleState(), "src");
    expect(html).toContain("acquireVsCodeApi");
    expect(html).toContain('postMessage({ type: "action", action:');
  });
});
