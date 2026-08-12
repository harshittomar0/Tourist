import { describe, expect, it } from "vitest";
import { buildSystemPrompt, buildUserContent, truncateEvidence, type EvidenceItem } from "../src/claude/buildPrompt.js";

describe("buildSystemPrompt", () => {
  it("embeds the guidelines markdown verbatim rather than paraphrasing it", () => {
    const guidelines = "## A unique marker heading\nSome unique guideline text 12345.";
    const prompt = buildSystemPrompt(guidelines);
    expect(prompt).toContain(guidelines);
  });

  it("states the provenance rule explicitly", () => {
    const prompt = buildSystemPrompt("guidelines");
    expect(prompt).toMatch(/provenance.*ai/i);
    expect(prompt).toMatch(/never emit "confirmed" or "gap"/i);
  });
});

describe("buildUserContent", () => {
  it("lists only the forests in scope in the header", () => {
    const content = buildUserContent(["cs"], []);
    expect(content).toContain("cs");
    expect(content).not.toContain("tech,");
  });

  it("includes each evidence item's ref and content", () => {
    const items: EvidenceItem[] = [{ source: "git", ref: "abc123", detail: "a commit", content: "diff body here" }];
    const content = buildUserContent(["tech"], items);
    expect(content).toContain("abc123");
    expect(content).toContain("diff body here");
  });
});

describe("truncateEvidence", () => {
  it("keeps everything when under budget", () => {
    const items: EvidenceItem[] = [{ source: "git", ref: "a", detail: "d", content: "short" }];
    expect(truncateEvidence(items, 10_000)).toHaveLength(1);
  });

  it("drops items once the budget is exceeded, truncating the one that overflows", () => {
    const items: EvidenceItem[] = [
      { source: "git", ref: "a", detail: "", content: "x".repeat(100) },
      { source: "git", ref: "b", detail: "", content: "y".repeat(100) },
      { source: "git", ref: "c", detail: "", content: "z".repeat(100) }
    ];

    const result = truncateEvidence(items, 150);

    expect(result.length).toBeLessThan(items.length);
    expect(result[0].ref).toBe("a");
  });
});
