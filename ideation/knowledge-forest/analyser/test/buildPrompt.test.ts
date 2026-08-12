import { describe, expect, it } from "vitest";
import {
  buildSystemPrompt,
  buildUserContent,
  renderExistingForest,
  truncateEvidence,
  type EvidenceItem
} from "../src/claude/buildPrompt.js";
import type { DeepDiveTopic, ForestFile, ForestNode } from "../src/types.js";

function node(partial: Partial<ForestNode> & { label: string }): ForestNode {
  return { provenance: "ai", proficiency: 0, children: [], latent: [], ...partial };
}

function emptyForest(): ForestFile {
  return { tech: [], cs: [], practice: [] };
}

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

  it("instructs the model to reuse existing labels and treat confirmed/gap as final", () => {
    const prompt = buildSystemPrompt("guidelines");
    expect(prompt).toMatch(/exact existing label/i);
    expect(prompt).toMatch(/"confirmed" or "gap".*human's final word/i);
  });

  it("instructs the model that tracked/ai categories should get updated proficiency from fresh evidence", () => {
    const prompt = buildSystemPrompt("guidelines");
    expect(prompt).toMatch(/"tracked"/);
    expect(prompt).toMatch(/does take effect/i);
  });

  it("adds no deep-dive section when no topics are given", () => {
    const prompt = buildSystemPrompt("guidelines");
    expect(prompt).not.toMatch(/deep dive/i);
  });

  it("appends a deep-dive addendum naming exactly the requested topics when given", () => {
    const topics: DeepDiveTopic[] = [
      { forestKind: "tech", path: ["Django", "ORM & migrations"] },
      { forestKind: "cs", path: ["Big-O / asymptotic analysis"] }
    ];
    const prompt = buildSystemPrompt("guidelines", topics);

    expect(prompt).toMatch(/deep dive/i);
    expect(prompt).toContain("Django > ORM & migrations");
    expect(prompt).toContain("Big-O / asymptotic analysis");
  });

  it("tells the model everything else should stay shallow during a deep dive", () => {
    const prompt = buildSystemPrompt("guidelines", [{ forestKind: "tech", path: ["Django"] }]);
    expect(prompt).toMatch(/normal shallow depth/i);
  });
});

describe("renderExistingForest", () => {
  it("reports no existing categories when the forest is empty", () => {
    const summary = renderExistingForest(["tech"], emptyForest());
    expect(summary).toMatch(/no existing categories/i);
  });

  it("renders label, provenance, and proficiency for each existing node", () => {
    const forest: ForestFile = { ...emptyForest(), tech: [node({ label: "Django", provenance: "confirmed", proficiency: 4 })] };
    const summary = renderExistingForest(["tech"], forest);
    expect(summary).toContain("Django");
    expect(summary).toContain("confirmed");
    expect(summary).toContain("4");
  });

  it("recurses into children", () => {
    const forest: ForestFile = {
      ...emptyForest(),
      tech: [node({ label: "Django", children: [node({ label: "ORM & migrations", provenance: "confirmed", proficiency: 3 })] })]
    };
    const summary = renderExistingForest(["tech"], forest);
    expect(summary).toContain("ORM & migrations");
  });

  it("omits latent stubs", () => {
    const forest: ForestFile = {
      ...emptyForest(),
      tech: [node({ label: "Django", latent: [node({ label: "Signals (latent guess)" })] })]
    };
    const summary = renderExistingForest(["tech"], forest);
    expect(summary).not.toContain("Signals (latent guess)");
  });

  it("only renders forests in scope", () => {
    const forest: ForestFile = {
      ...emptyForest(),
      tech: [node({ label: "Django" })],
      cs: [node({ label: "Big-O" })]
    };
    const summary = renderExistingForest(["tech"], forest);
    expect(summary).toContain("Django");
    expect(summary).not.toContain("Big-O");
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

  it("defaults to an empty existing-forest snapshot when none is passed", () => {
    const content = buildUserContent(["tech"], []);
    expect(content).toMatch(/no existing categories/i);
  });

  it("includes the existing forest's labels so the model can see what's already there", () => {
    const existing: ForestFile = { ...emptyForest(), tech: [node({ label: "Kubernetes debugging", provenance: "gap" })] };
    const content = buildUserContent(["tech"], [], existing);
    expect(content).toContain("<existing-forest>");
    expect(content).toContain("Kubernetes debugging");
    expect(content).toContain("gap");
  });

  it("does not leak an existing node from a forest that's out of scope", () => {
    const existing: ForestFile = { ...emptyForest(), cs: [node({ label: "Big-O" })] };
    const content = buildUserContent(["tech"], [], existing);
    expect(content).not.toContain("Big-O");
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
