import { describe, expect, it } from "vitest";
import {
  buildStandaloneDashboardPage,
  injectDashboardChrome,
  isDashboardTab,
  nextDashboardTab,
  renderTabStrip,
  type DashboardTab,
} from "../../src/vscode-integration/knowledge-map/dashboard-tabs.ts";

describe("isDashboardTab", () => {
  it("accepts the three known tab ids", () => {
    expect(isDashboardTab("knowledge-map")).toBe(true);
    expect(isDashboardTab("hook-setup")).toBe(true);
    expect(isDashboardTab("git-notes")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isDashboardTab("settings")).toBe(false);
    expect(isDashboardTab(undefined)).toBe(false);
    expect(isDashboardTab(42)).toBe(false);
  });
});

describe("nextDashboardTab (pure tab-switching state transition)", () => {
  it("switches to the requested tab when it's valid", () => {
    expect(nextDashboardTab("knowledge-map", "git-notes")).toBe("git-notes");
    expect(nextDashboardTab("git-notes", "hook-setup")).toBe("hook-setup");
  });

  it("stays on the current tab for a malformed/unrecognized request", () => {
    expect(nextDashboardTab("knowledge-map", "not-a-tab")).toBe("knowledge-map");
    expect(nextDashboardTab("git-notes", undefined)).toBe("git-notes");
    expect(nextDashboardTab("hook-setup", null)).toBe("hook-setup");
  });
});

describe("renderTabStrip", () => {
  it("renders all three tabs and marks only the active one", () => {
    const html = renderTabStrip("hook-setup");
    expect(html).toContain('data-tab="knowledge-map"');
    expect(html).toContain('data-tab="hook-setup"');
    expect(html).toContain('data-tab="git-notes"');

    const activeButtonMatch = html.match(/<button[^>]*class="km-dashboard-tab active"[^>]*>/);
    expect(activeButtonMatch).not.toBeNull();
    expect(activeButtonMatch![0]).toContain('data-tab="hook-setup"');
  });

  it("marks a different tab active when given a different id", () => {
    const html = renderTabStrip("git-notes");
    const activeButtonMatch = html.match(/<button[^>]*class="km-dashboard-tab active"[^>]*>/);
    expect(activeButtonMatch![0]).toContain('data-tab="git-notes"');
  });
});

describe("injectDashboardChrome", () => {
  it("inserts the tab strip right after <body> and a nonce'd script before </body>", () => {
    const doc = "<!DOCTYPE html><html><head></head><body><p>content</p></body></html>";
    const html = injectDashboardChrome(doc, "knowledge-map", "abc123");

    expect(html).toContain(`<script nonce="abc123">`);
    const bodyIdx = html.indexOf("<body>");
    const navIdx = html.indexOf("km-dashboard-tabstrip");
    const contentIdx = html.indexOf("<p>content</p>");
    const scriptIdx = html.indexOf('<script nonce="abc123">');
    const closeBodyIdx = html.indexOf("</body>");

    expect(bodyIdx).toBeLessThan(navIdx);
    expect(navIdx).toBeLessThan(contentIdx);
    expect(contentIdx).toBeLessThan(scriptIdx);
    expect(scriptIdx).toBeLessThan(closeBodyIdx);
  });

  it("guards acquireVsCodeApi behind a window-level singleton", () => {
    const html = injectDashboardChrome("<html><body></body></html>", "git-notes", "n1");
    expect(html).toContain("window.__touristVscodeApi");
  });

  it("doesn't insert a tab strip when there's no <body> tag at all, but still appends the script", () => {
    const doc = "<div>not a full document</div>";
    const html = injectDashboardChrome(doc, "knowledge-map", "n");
    expect(html.startsWith(doc)).toBe(true);
    expect(html).not.toContain("km-dashboard-tabstrip");
    expect(html).toContain(`<script nonce="n">`);
  });

  it("preserves attributes on an existing <body> tag", () => {
    const doc = `<html><body class="foo" data-x="1"><span/></body></html>`;
    const html = injectDashboardChrome(doc, "knowledge-map", "n2");
    expect(html).toContain(`<body class="foo" data-x="1">`);
  });
});

describe("dashboard tab-strip script (click wiring)", () => {
  it("posts a switchTab message for tab buttons and dashboardAction for [data-action] buttons", () => {
    const html = injectDashboardChrome("<html><body></body></html>", "knowledge-map", "n3");
    expect(html).toContain('postMessage({ type: "switchTab", tab:');
    expect(html).toContain('postMessage({ type: "dashboardAction", action:');
  });
});

describe("buildStandaloneDashboardPage", () => {
  it("produces a full document with CSP, the given cspSource, and the active tab's chrome", () => {
    const html = buildStandaloneDashboardPage("<p>Hook Setup body</p>", "hook-setup" as DashboardTab, "vscode-webview://source");
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("vscode-webview://source");
    expect(html).toContain("<p>Hook Setup body</p>");
    const activeButtonMatch = html.match(/<button[^>]*class="km-dashboard-tab active"[^>]*>/);
    expect(activeButtonMatch![0]).toContain('data-tab="hook-setup"');
  });

  it("includes any extra style passed in", () => {
    const html = buildStandaloneDashboardPage("<p>x</p>", "git-notes", "src", ".km-custom { color: red; }");
    expect(html).toContain(".km-custom { color: red; }");
  });
});
