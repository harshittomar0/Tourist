import { describe, expect, it } from "vitest";
import { resolveDeepDiveTopics } from "../src/forest/deepDive.js";
import type { ForestFile, ForestNode } from "../src/types.js";

function node(partial: Partial<ForestNode> & { label: string }): ForestNode {
  return { provenance: "ai", proficiency: 0, children: [], latent: [], ...partial };
}

function emptyForest(): ForestFile {
  return { tech: [], cs: [], practice: [] };
}

describe("resolveDeepDiveTopics", () => {
  it("resolves a bare label found anywhere in the tree", () => {
    const forest: ForestFile = {
      ...emptyForest(),
      tech: [node({ label: "Django", children: [node({ label: "ORM & migrations" })] })]
    };

    const { resolved, notFound } = resolveDeepDiveTopics(["ORM & migrations"], forest);

    expect(notFound).toEqual([]);
    expect(resolved).toEqual([{ forestKind: "tech", path: ["ORM & migrations"] }]);
  });

  it("resolves a top-level label", () => {
    const forest: ForestFile = { ...emptyForest(), tech: [node({ label: "Django" })] };
    const { resolved } = resolveDeepDiveTopics(["Django"], forest);
    expect(resolved).toEqual([{ forestKind: "tech", path: ["Django"] }]);
  });

  it("resolves a '>' separated chain requiring parent-child order", () => {
    const forest: ForestFile = {
      ...emptyForest(),
      tech: [node({ label: "Django", children: [node({ label: "ORM & migrations" })] })]
    };

    const { resolved } = resolveDeepDiveTopics(["Django > ORM & migrations"], forest);
    expect(resolved).toEqual([{ forestKind: "tech", path: ["Django", "ORM & migrations"] }]);
  });

  it("does not resolve a chain where the order doesn't match parent/child", () => {
    const forest: ForestFile = {
      ...emptyForest(),
      tech: [node({ label: "Django", children: [node({ label: "ORM & migrations" })] })]
    };

    const { resolved, notFound } = resolveDeepDiveTopics(["ORM & migrations > Django"], forest);
    expect(resolved).toEqual([]);
    expect(notFound).toEqual(["ORM & migrations > Django"]);
  });

  it("reports a label that doesn't exist anywhere as notFound instead of erroring", () => {
    const forest: ForestFile = { ...emptyForest(), tech: [node({ label: "Django" })] };

    const { resolved, notFound } = resolveDeepDiveTopics(["Rust", "Django"], forest);

    expect(notFound).toEqual(["Rust"]);
    expect(resolved).toEqual([{ forestKind: "tech", path: ["Django"] }]);
  });

  it("finds a label in whichever forest actually has it", () => {
    const forest: ForestFile = { ...emptyForest(), cs: [node({ label: "Big-O / asymptotic analysis" })] };

    const { resolved } = resolveDeepDiveTopics(["Big-O / asymptotic analysis"], forest);
    expect(resolved).toEqual([{ forestKind: "cs", path: ["Big-O / asymptotic analysis"] }]);
  });

  it("ignores blank entries and trims whitespace", () => {
    const forest: ForestFile = { ...emptyForest(), tech: [node({ label: "Django" })] };

    const { resolved, notFound } = resolveDeepDiveTopics(["  Django  ", "", "   "], forest);

    expect(resolved).toEqual([{ forestKind: "tech", path: ["Django"] }]);
    expect(notFound).toEqual([]);
  });

  it("dedupes repeated requests for the same resolved topic", () => {
    const forest: ForestFile = { ...emptyForest(), tech: [node({ label: "Django" })] };

    const { resolved } = resolveDeepDiveTopics(["Django", "Django"], forest);

    expect(resolved).toHaveLength(1);
  });

  it("returns empty resolution for an empty forest and reports every request as not found", () => {
    const { resolved, notFound } = resolveDeepDiveTopics(["Django"], emptyForest());
    expect(resolved).toEqual([]);
    expect(notFound).toEqual(["Django"]);
  });
});
