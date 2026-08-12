import { describe, expect, it } from "vitest";
import { parseForestResponse, ForestValidationError } from "../src/forest/validate.js";

const validEvidence = [{ source: "git", ref: "abc123", detail: "seen in commit abc123" }];

describe("parseForestResponse", () => {
  it("parses a well-formed response", () => {
    const raw = JSON.stringify({
      tech: [{ label: "Django", provenance: "ai", proficiency: 3, children: [], latent: [], evidence: validEvidence }],
      cs: [],
      practice: []
    });

    const result = parseForestResponse(raw);

    expect(result.tech).toHaveLength(1);
    expect(result.tech[0].label).toBe("Django");
  });

  it("strips a markdown code fence if the model wraps its JSON in one", () => {
    const raw = "```json\n" + JSON.stringify({ tech: [], cs: [], practice: [] }) + "\n```";
    expect(() => parseForestResponse(raw)).not.toThrow();
  });

  it("forces provenance to 'ai' even if the model tries to emit 'confirmed'", () => {
    const raw = JSON.stringify({
      tech: [{ label: "Django", provenance: "confirmed", proficiency: 5, children: [], latent: [], evidence: validEvidence }],
      cs: [],
      practice: []
    });

    const result = parseForestResponse(raw);

    expect(result.tech[0].provenance).toBe("ai");
  });

  it("drops a node with no evidence entries", () => {
    const raw = JSON.stringify({
      tech: [{ label: "Django", provenance: "ai", proficiency: 3, children: [], latent: [], evidence: [] }],
      cs: [],
      practice: []
    });

    const result = parseForestResponse(raw);

    expect(result.tech).toHaveLength(0);
  });

  it("drops a node missing the evidence field entirely", () => {
    const raw = JSON.stringify({
      tech: [{ label: "Django", provenance: "ai", proficiency: 3, children: [], latent: [] }],
      cs: [],
      practice: []
    });

    const result = parseForestResponse(raw);

    expect(result.tech).toHaveLength(0);
  });

  it("clamps out-of-range proficiency into 0-5", () => {
    const raw = JSON.stringify({
      tech: [{ label: "Django", provenance: "ai", proficiency: 99, children: [], latent: [], evidence: validEvidence }],
      cs: [],
      practice: []
    });

    const result = parseForestResponse(raw);

    expect(result.tech[0].proficiency).toBe(5);
  });

  it("throws ForestValidationError on invalid JSON", () => {
    expect(() => parseForestResponse("not json at all")).toThrow(ForestValidationError);
  });

  it("throws ForestValidationError when a forest key is not an array", () => {
    const raw = JSON.stringify({ tech: "nope", cs: [], practice: [] });
    expect(() => parseForestResponse(raw)).toThrow(ForestValidationError);
  });

  it("treats a missing forest key as an empty array rather than an error", () => {
    const raw = JSON.stringify({ tech: [] });
    const result = parseForestResponse(raw);
    expect(result.cs).toEqual([]);
    expect(result.practice).toEqual([]);
  });

  it("recursively sanitizes children and latent nodes", () => {
    const raw = JSON.stringify({
      tech: [
        {
          label: "Django",
          provenance: "ai",
          proficiency: 3,
          evidence: validEvidence,
          children: [
            { label: "ORM", provenance: "confirmed", proficiency: 4, evidence: validEvidence, children: [], latent: [] },
            { label: "No evidence here", provenance: "ai", proficiency: 2, evidence: [], children: [], latent: [] }
          ],
          latent: []
        }
      ],
      cs: [],
      practice: []
    });

    const result = parseForestResponse(raw);

    expect(result.tech[0].children).toHaveLength(1); // the no-evidence child was dropped
    expect(result.tech[0].children[0].provenance).toBe("ai"); // forced, even though input said "confirmed"
  });
});
