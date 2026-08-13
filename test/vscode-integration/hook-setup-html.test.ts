import { describe, expect, it } from "vitest";
import { buildHookSetupBodyHtml } from "../../src/vscode-integration/knowledge-map/hook-setup-html.ts";

describe("buildHookSetupBodyHtml", () => {
  it("shows an installed badge and both actions when installed", () => {
    const html = buildHookSetupBodyHtml({ scriptExists: true, installed: true, hookScriptPath: "/x/hook.mjs" });
    expect(html).toContain("km-badge-ok");
    expect(html).toContain("Installed");
    expect(html).toContain('data-action="installHook"');
    expect(html).toContain('data-action="verifyHook"');
  });

  it("shows a warn badge when the script exists but isn't installed", () => {
    const html = buildHookSetupBodyHtml({ scriptExists: true, installed: false, hookScriptPath: "/x/hook.mjs" });
    expect(html).toContain("km-badge-warn");
    expect(html).toContain("Not installed");
  });

  it("shows an error badge when the script is missing, taking priority over installed state", () => {
    const html = buildHookSetupBodyHtml({ scriptExists: false, installed: false, hookScriptPath: "/x/hook.mjs" });
    expect(html).toContain("km-badge-error");
    expect(html).toContain("Script missing");
  });

  it("explains what Tier 1 coverage means", () => {
    const html = buildHookSetupBodyHtml({ scriptExists: true, installed: true, hookScriptPath: "/x/hook.mjs" });
    expect(html).toMatch(/Tier 1/);
    expect(html).toMatch(/PreToolUse\/PostToolUse|PreToolUse.*PostToolUse/);
  });

  it("shows the hook script path, HTML-escaped", () => {
    const html = buildHookSetupBodyHtml({ scriptExists: true, installed: true, hookScriptPath: '/x/"><script>.mjs' });
    expect(html).toContain("/x/&quot;&gt;&lt;script&gt;.mjs");
    expect(html).not.toContain('"><script>.mjs');
  });
});
