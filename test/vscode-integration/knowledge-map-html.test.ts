import { describe, expect, it } from "vitest";
import {
  buildKnowledgeMapHtml,
  injectContentSecurityPolicy,
  injectOverrideBridge,
  injectRealForestData,
  makeNonce,
} from "../../src/vscode-integration/knowledge-map/html.ts";
import type { ForestFile } from "../../src/vscode-integration/knowledge-map/types.ts";

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
