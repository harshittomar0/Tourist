import { describe, expect, it } from "vitest";
import { mergeForest } from "../src/forest/merge.js";
import type { ForestFile, ForestNode } from "../src/types.js";

function node(partial: Partial<ForestNode> & { label: string }): ForestNode {
  return {
    provenance: "ai",
    proficiency: 0,
    children: [],
    latent: [],
    ...partial
  };
}

function empty(): ForestFile {
  return { tech: [], cs: [], practice: [] };
}

describe("mergeForest", () => {
  it("never overwrites a confirmed node's proficiency or provenance", () => {
    const existing: ForestFile = { ...empty(), tech: [node({ label: "Django", provenance: "confirmed", proficiency: 4 })] };
    const incoming: ForestFile = { ...empty(), tech: [node({ label: "Django", provenance: "ai", proficiency: 1 })] };

    const result = mergeForest(existing, incoming);

    expect(result.tech).toHaveLength(1);
    expect(result.tech[0]).toMatchObject({ provenance: "confirmed", proficiency: 4 });
  });

  it("never overwrites a declared gap", () => {
    const existing: ForestFile = { ...empty(), cs: [node({ label: "Security Fundamentals", provenance: "gap", proficiency: 0 })] };
    const incoming: ForestFile = { ...empty(), cs: [node({ label: "Security Fundamentals", provenance: "ai", proficiency: 3 })] };

    const result = mergeForest(existing, incoming);

    expect(result.cs[0].provenance).toBe("gap");
    expect(result.cs[0].proficiency).toBe(0);
  });

  it("lets a fresh ai guess replace a previous ai guess for the same label", () => {
    const existing: ForestFile = { ...empty(), tech: [node({ label: "Redux", provenance: "ai", proficiency: 1 })] };
    const incoming: ForestFile = { ...empty(), tech: [node({ label: "Redux", provenance: "ai", proficiency: 3 })] };

    const result = mergeForest(existing, incoming);

    expect(result.tech[0].proficiency).toBe(3);
  });

  it("appends a genuinely new label as a new ai node", () => {
    const existing = empty();
    const incoming: ForestFile = { ...empty(), practice: [node({ label: "Documentation habits", provenance: "ai", proficiency: 2 })] };

    const result = mergeForest(existing, incoming);

    expect(result.practice).toHaveLength(1);
    expect(result.practice[0].label).toBe("Documentation habits");
  });

  it("does not delete an existing node the new run didn't mention", () => {
    const existing: ForestFile = { ...empty(), tech: [node({ label: "Kubernetes debugging", provenance: "gap" })] };
    const incoming = empty();

    const result = mergeForest(existing, incoming);

    expect(result.tech).toHaveLength(1);
  });

  it("updates a tracked node's proficiency/evidence from a fresh ai guess, but keeps it tracked", () => {
    const existing: ForestFile = {
      ...empty(),
      tech: [node({ label: "Rust", provenance: "tracked", proficiency: 1, evidence: [] })]
    };
    const incoming: ForestFile = {
      ...empty(),
      tech: [
        node({
          label: "Rust",
          provenance: "ai",
          proficiency: 3,
          evidence: [{ source: "git", ref: "abc123", detail: "Cargo.toml added" }]
        })
      ]
    };

    const result = mergeForest(existing, incoming);

    expect(result.tech).toHaveLength(1);
    expect(result.tech[0].provenance).toBe("tracked"); // stays tracked, not overwritten to "ai"
    expect(result.tech[0].proficiency).toBe(3); // proficiency DOES update, unlike confirmed/gap
    expect(result.tech[0].evidence).toEqual([{ source: "git", ref: "abc123", detail: "Cargo.toml added" }]);
  });

  it("leaves a tracked node untouched when no incoming guess matches its label", () => {
    const existing: ForestFile = {
      ...empty(),
      tech: [node({ label: "Rust", provenance: "tracked", proficiency: 1 })]
    };
    const incoming = empty();

    const result = mergeForest(existing, incoming);

    expect(result.tech[0]).toMatchObject({ provenance: "tracked", proficiency: 1 });
  });

  it("recurses into a tracked parent's children the same way it does for ai nodes", () => {
    const existing: ForestFile = {
      ...empty(),
      tech: [node({ label: "Rust", provenance: "tracked", proficiency: 1, children: [] })]
    };
    const incoming: ForestFile = {
      ...empty(),
      tech: [
        node({
          label: "Rust",
          provenance: "ai",
          proficiency: 2,
          children: [node({ label: "Ownership & borrowing", provenance: "ai", proficiency: 2 })]
        })
      ]
    };

    const result = mergeForest(existing, incoming);

    expect(result.tech[0].provenance).toBe("tracked");
    expect(result.tech[0].children).toHaveLength(1);
    expect(result.tech[0].children[0].label).toBe("Ownership & borrowing");
  });

  it("updates a reopened confirmed node's proficiency/evidence for that one call, while a non-reopened confirmed node stays frozen", () => {
    const existing: ForestFile = {
      ...empty(),
      tech: [
        node({ label: "Django", provenance: "confirmed", proficiency: 4, evidence: [] }),
        node({ label: "Flask", provenance: "confirmed", proficiency: 2, evidence: [] })
      ]
    };
    const incoming: ForestFile = {
      ...empty(),
      tech: [
        node({
          label: "Django",
          provenance: "ai",
          proficiency: 1,
          evidence: [{ source: "git", ref: "def456", detail: "New Django signals usage" }]
        }),
        node({ label: "Flask", provenance: "ai", proficiency: 5 })
      ]
    };

    const result = mergeForest(existing, incoming, [{ forestKind: "tech", path: ["Django"] }]);

    const django = result.tech.find((n) => n.label === "Django")!;
    expect(django.provenance).toBe("confirmed"); // provenance never rewritten to "tracked"
    expect(django.proficiency).toBe(1); // reopened: fresh guess updates proficiency
    expect(django.evidence).toEqual([{ source: "git", ref: "def456", detail: "New Django signals usage" }]);

    const flask = result.tech.find((n) => n.label === "Flask")!;
    expect(flask.provenance).toBe("confirmed");
    expect(flask.proficiency).toBe(2); // not reopened: still fully frozen
  });

  it("reverts a reopened node to full freeze on the next merge call once --reopen isn't passed again", () => {
    const existing: ForestFile = {
      ...empty(),
      tech: [node({ label: "Django", provenance: "confirmed", proficiency: 4 })]
    };
    const firstIncoming: ForestFile = {
      ...empty(),
      tech: [node({ label: "Django", provenance: "ai", proficiency: 1 })]
    };

    const afterReopen = mergeForest(existing, firstIncoming, [{ forestKind: "tech", path: ["Django"] }]);
    expect(afterReopen.tech[0]).toMatchObject({ provenance: "confirmed", proficiency: 1 });

    const secondIncoming: ForestFile = {
      ...empty(),
      tech: [node({ label: "Django", provenance: "ai", proficiency: 5 })]
    };

    // No reopen list passed this time -- the node is fully frozen again.
    const afterSecondRun = mergeForest(afterReopen, secondIncoming);
    expect(afterSecondRun.tech[0]).toMatchObject({ provenance: "confirmed", proficiency: 1 });
  });

  // Regression for the vscode-integration/knowledge-map "Re-review" bug:
  // reopenKeys are built from the FULL root-to-node ancestor path
  // (`reopenKey(kind, path)` where `path` is `[...parentPath, label]`), not
  // the node's bare label. A reopen target carrying only the bare label of a
  // nested node never matches, so the confirmed/gap node stays frozen -- a
  // silent no-op. This is exactly what html.ts's pre-fix bug sent.
  it("reopens a nested confirmed node only when the reopen target carries its full ancestor path, not just its bare label", () => {
    const existing: ForestFile = {
      ...empty(),
      tech: [
        node({
          label: "Django",
          provenance: "confirmed",
          proficiency: 4,
          children: [node({ label: "ORM & migrations", provenance: "confirmed", proficiency: 2, evidence: [] })]
        })
      ]
    };
    const incoming: ForestFile = {
      ...empty(),
      tech: [
        node({
          label: "Django",
          provenance: "ai",
          proficiency: 1,
          children: [
            node({
              label: "ORM & migrations",
              provenance: "ai",
              proficiency: 5,
              evidence: [{ source: "git", ref: "abc123", detail: "new migration files" }]
            })
          ]
        })
      ]
    };

    // Bare label only -- what html.ts used to send. Doesn't match the
    // nested node's real key ("tech:Django>ORM & migrations"), so it's a
    // silent no-op.
    const withBareLabel = mergeForest(existing, incoming, [{ forestKind: "tech", path: ["ORM & migrations"] }]);
    const ormBare = withBareLabel.tech[0].children.find((n) => n.label === "ORM & migrations")!;
    expect(ormBare.proficiency).toBe(2);
    expect(ormBare.provenance).toBe("confirmed");

    // Full ancestor path -- what html.ts sends after the fix. Matches and
    // reopens the node for this call only.
    const withFullPath = mergeForest(existing, incoming, [{ forestKind: "tech", path: ["Django", "ORM & migrations"] }]);
    const ormFull = withFullPath.tech[0].children.find((n) => n.label === "ORM & migrations")!;
    expect(ormFull.proficiency).toBe(5);
    expect(ormFull.provenance).toBe("confirmed"); // never rewritten to "tracked"
    expect(ormFull.evidence).toEqual([{ source: "git", ref: "abc123", detail: "new migration files" }]);
  });

  it("recurses into a confirmed parent's children so new sub-nodes can still be proposed", () => {
    const existing: ForestFile = {
      ...empty(),
      tech: [node({ label: "Django", provenance: "confirmed", proficiency: 4, children: [] })]
    };
    const incoming: ForestFile = {
      ...empty(),
      tech: [
        node({
          label: "Django",
          provenance: "ai",
          proficiency: 1,
          children: [node({ label: "Signals", provenance: "ai", proficiency: 2 })]
        })
      ]
    };

    const result = mergeForest(existing, incoming);

    expect(result.tech[0].provenance).toBe("confirmed"); // parent untouched
    expect(result.tech[0].proficiency).toBe(4); // parent untouched
    expect(result.tech[0].children).toHaveLength(1); // new child still lands
    expect(result.tech[0].children[0].label).toBe("Signals");
  });
});
