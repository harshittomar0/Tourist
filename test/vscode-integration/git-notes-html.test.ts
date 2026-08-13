import { describe, expect, it } from "vitest";
import { buildGitNotesBodyHtml } from "../../src/vscode-integration/knowledge-map/git-notes-html.ts";

describe("buildGitNotesBodyHtml", () => {
  it("shows an On badge and enabled Push/Fetch buttons when sync is on", () => {
    const html = buildGitNotesBodyHtml({ enabled: true, remote: "origin" });
    expect(html).toContain("km-badge-ok");
    expect(html).toContain("origin");
    expect(html).not.toMatch(/data-action="pushNotes"[^>]*disabled/);
    expect(html).not.toMatch(/data-action="fetchNotes"[^>]*disabled/);
  });

  it("shows an Off badge and disabled Push/Fetch buttons when sync is off", () => {
    const html = buildGitNotesBodyHtml({ enabled: false, remote: "origin" });
    expect(html).toContain("km-badge-warn");
    expect(html).toMatch(/data-action="pushNotes" disabled/);
    expect(html).toMatch(/data-action="fetchNotes" disabled/);
  });

  it("shows the last push/fetch result when given", () => {
    const html = buildGitNotesBodyHtml({ enabled: true, remote: "origin", lastResult: "pushed 3 notes" });
    expect(html).toContain("Last result:");
    expect(html).toContain("pushed 3 notes");
  });

  it("omits the last-result line entirely when none is given", () => {
    const html = buildGitNotesBodyHtml({ enabled: true, remote: "origin" });
    expect(html).not.toContain("Last result:");
  });

  it("escapes the remote name", () => {
    const html = buildGitNotesBodyHtml({ enabled: true, remote: '<script>evil()</script>' });
    expect(html).not.toContain("<script>evil()</script>");
    expect(html).toContain("&lt;script&gt;evil()&lt;/script&gt;");
  });
});
