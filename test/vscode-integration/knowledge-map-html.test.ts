import { readFileSync } from "node:fs";
import * as path from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  buildKnowledgeMapHtml,
  injectContentSecurityPolicy,
  injectOverrideBridge,
  injectRealForestData,
  injectTheme,
  makeNonce,
} from "../../src/vscode-integration/knowledge-map/html.ts";
import type { ForestFile } from "../../src/vscode-integration/knowledge-map/types.ts";

const REAL_TEMPLATE_PATH = path.join(__dirname, "..", "..", "ideation", "knowledge-forest", "ui", "knowledge-forest.html");

// A minimal stand-in for ui/knowledge-forest.html's shape: only the
// anchor substrings injectRealForestData/injectContentSecurityPolicy/
// injectOverrideBridge actually depend on, kept separate from the real
// (and out-of-scope-to-edit) ideation/knowledge-forest/ui/knowledge-forest.html
// so this test doesn't drift if that file's internals change.
const FAKE_TEMPLATE = `<!DOCTYPE html>
<html>
<head>
<title>fake</title>
</head>
<body>
<div id="forest-tech"></div>
<div id="forest-cs"></div>
<div id="forest-practice"></div>
<script>
(function () {
  var techForestData = [
    mkNode("Demo", "confirmed", 3)
  ];

  var csForestData = [
    mkNode("Demo cs", "confirmed", 3)
  ];

  var practiceForestData = [
    mkNode("Demo practice", "confirmed", 3)
  ];

  // ---------------- rendering (shared, stateless) ----------------
})();
</script>
</body>
</html>`;

function sampleForest(): ForestFile {
  return {
    tech: [{ label: "Backend — Python", provenance: "confirmed", proficiency: 4, children: [], latent: [] }],
    cs: [],
    practice: [],
  };
}

describe("injectRealForestData", () => {
  it("replaces the three demo arrays with real (hydrated) data", () => {
    const html = injectRealForestData(FAKE_TEMPLATE, sampleForest());
    expect(html).not.toContain("mkNode(\"Demo\"");
    expect(html).toContain("var techForestData = [{\"label\":\"Backend — Python\"");
    expect(html).toContain("\"expanded\":true");
    expect(html).toContain("var csForestData = [];");
    expect(html).toContain("var practiceForestData = [];");
  });

  it("leaves html untouched for a section whose anchor is missing (defensive fallback)", () => {
    const withoutAnchor = FAKE_TEMPLATE.replace("var techForestData = [", "var somethingElse = [");
    const html = injectRealForestData(withoutAnchor, sampleForest());
    expect(html).toContain("var somethingElse = [");
    expect(html).toContain("var csForestData = [];");
  });
});

describe("injectContentSecurityPolicy", () => {
  it("adds a nonce'd CSP meta tag and nonces the inline script", () => {
    const nonce = "abc123";
    const html = injectContentSecurityPolicy(FAKE_TEMPLATE, nonce, "vscode-webview://source");
    expect(html).toContain(`script-src 'nonce-${nonce}'`);
    expect(html).toContain(`<script nonce="${nonce}">`);
  });
});

describe("injectOverrideBridge", () => {
  it("appends a nonce'd bridge script before </body>", () => {
    const nonce = "xyz789";
    const html = injectOverrideBridge(FAKE_TEMPLATE, nonce);
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain("acquireVsCodeApi");
    expect(html).toContain("Deep Dive on Selected");
    expect(html.indexOf(`<script nonce="${nonce}">`)).toBeLessThan(html.indexOf("</body>"));
  });
});

describe("makeNonce", () => {
  it("produces distinct values", () => {
    expect(makeNonce()).not.toBe(makeNonce());
  });
});

describe("buildKnowledgeMapHtml", () => {
  it("composes all three transforms", () => {
    const html = buildKnowledgeMapHtml(FAKE_TEMPLATE, sampleForest(), "vscode-webview://source");
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("Backend — Python");
    expect(html).toContain("Deep Dive on Selected");
  });
});

describe("injectTheme", () => {
  const withHtmlTag = `<!DOCTYPE html>\n<html lang="en" data-theme="light">\n<body></body>\n</html>`;

  it("overrides the raw file's hardcoded data-theme when a theme is given", () => {
    expect(injectTheme(withHtmlTag, "dark")).toContain('<html lang="en" data-theme="dark">');
  });

  it("leaves the html untouched when no theme is given", () => {
    expect(injectTheme(withHtmlTag, undefined)).toBe(withHtmlTag);
  });
});

// Regression coverage for a reported bug: "ticking a topic checkbox resets
// the theme selector to light". These tests render the *actual*
// ideation/knowledge-forest/ui/knowledge-forest.html (not the FAKE_TEMPLATE
// stand-in above) through jsdom with scripts enabled, since the bug is
// about real runtime DOM/event behavior that a string-only test can't see.
describe("deep-dive checkbox vs. theme (regression)", () => {
  function renderIntoDom(theme?: string): { dom: JSDOM; document: Document } {
    const raw = readFileSync(REAL_TEMPLATE_PATH, "utf8");
    const forest: ForestFile = {
      tech: [{ label: "Demo Topic", provenance: "confirmed", proficiency: 3, children: [], latent: [] }],
      cs: [],
      practice: [],
    };
    const html = buildKnowledgeMapHtml(raw, forest, "vscode-webview://source", theme);
    const dom = new JSDOM(html, {
      runScripts: "dangerously",
      pretendToBeVisual: true,
      beforeParse(window) {
        (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
          postMessage: () => {},
          getState: () => undefined,
          setState: () => {},
        });
      },
    });
    return { dom, document: dom.window.document };
  }

  it("does NOT change data-theme merely from checking a checkbox (click+change), confirming stopPropagation on click is not the actual mechanism", async () => {
    const { dom, document } = renderIntoDom();
    // give the inline scripts a tick to finish running
    await new Promise((r) => setTimeout(r, 20));

    const themeSelect = document.getElementById("themeSelect") as HTMLSelectElement;
    themeSelect.value = "dark";
    themeSelect.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    const cb = document.querySelector(".km-select-checkbox") as HTMLInputElement | null;
    expect(cb).not.toBeNull();
    cb!.click(); // real browsers dispatch click then change for a checkbox
    await new Promise((r) => setTimeout(r, 20));

    expect(cb!.checked).toBe(true);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("preserves the live theme when panel.ts re-renders after a deep-dive/node-override round trip", async () => {
    // First render, as panel.ts does when the panel is first opened.
    const first = renderIntoDom();
    await new Promise((r) => setTimeout(r, 20));
    const themeSelect = first.document.getElementById("themeSelect") as HTMLSelectElement;
    themeSelect.value = "dark";
    themeSelect.dispatchEvent(new first.dom.window.Event("change", { bubbles: true }));
    expect(first.document.documentElement.getAttribute("data-theme")).toBe("dark");

    // panel.ts's render() re-reads the raw file from disk and calls
    // buildKnowledgeMapHtml again on every nodeOverride/deepDive message --
    // i.e. a brand new document, not a DOM mutation of the existing one.
    // Without threading the reported theme through, this is where the
    // reset actually happens.
    const second = renderIntoDom("dark");
    await new Promise((r) => setTimeout(r, 20));
    expect(second.document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});
