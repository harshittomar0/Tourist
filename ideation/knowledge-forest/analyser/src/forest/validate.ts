import type { Evidence, ForestFile, ForestNode } from "../types.js";

export class ForestValidationError extends Error {}

/**
 * Parses and validates a raw Claude response as a ForestFile. Never trusts
 * the model:
 *  - any node's "provenance" is force-set to "ai" regardless of what the
 *    model wrote, per taxonomy-guidelines.md's provenance rule (only a
 *    human can produce "confirmed" or "gap").
 *  - a node with no evidence array (or an empty one) is dropped, not kept
 *    with an empty array — an unsupported claim isn't a lesser claim, it's
 *    not a claim.
 *  - proficiency is clamped to the 0-5 integer range.
 * Throws ForestValidationError on structurally invalid input (wrong
 * top-level shape, non-object nodes, etc.) rather than silently coercing —
 * a malformed response should fail loudly so the run can be retried, not
 * silently produce an empty forest.
 */
export function parseForestResponse(raw: string): ForestFile {
  let json: unknown;
  try {
    json = JSON.parse(stripCodeFence(raw));
  } catch (err) {
    throw new ForestValidationError(`Claude response was not valid JSON: ${(err as Error).message}`);
  }
  if (typeof json !== "object" || json === null) {
    throw new ForestValidationError("Claude response was not a JSON object.");
  }
  const obj = json as Record<string, unknown>;

  return {
    tech: sanitizeNodeArray(obj.tech, "tech"),
    cs: sanitizeNodeArray(obj.cs, "cs"),
    practice: sanitizeNodeArray(obj.practice, "practice")
  };
}

function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenceMatch ? fenceMatch[1] : trimmed;
}

function sanitizeNodeArray(value: unknown, forestName: string): ForestNode[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ForestValidationError(`"${forestName}" must be an array, got ${typeof value}.`);
  }
  const nodes: ForestNode[] = [];
  for (const raw of value) {
    const node = sanitizeNode(raw, forestName);
    if (node) nodes.push(node);
  }
  return nodes;
}

function sanitizeNode(raw: unknown, forestName: string): ForestNode | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;

  if (typeof r.label !== "string" || r.label.trim().length === 0) return null;

  const evidence = sanitizeEvidence(r.evidence);
  if (evidence.length === 0) {
    // No citation → per the output contract this shouldn't have been emitted at all. Drop it rather than keep an unsupported node.
    return null;
  }

  const proficiency = clampProficiency(r.proficiency);
  const children = Array.isArray(r.children) ? r.children.map((c) => sanitizeNode(c, forestName)).filter(isNode) : [];
  const latent = Array.isArray(r.latent) ? r.latent.map((c) => sanitizeNode(c, forestName)).filter(isNode) : [];

  return {
    label: r.label.trim(),
    provenance: "ai", // forced — see module docstring
    proficiency,
    children,
    latent,
    evidence
  };
}

function isNode(n: ForestNode | null): n is ForestNode {
  return n !== null;
}

function clampProficiency(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(5, Math.round(n)));
}

function sanitizeEvidence(value: unknown): Evidence[] {
  if (!Array.isArray(value)) return [];
  const out: Evidence[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    if (r.source !== "git" && r.source !== "attribution" && r.source !== "prompt") continue;
    if (typeof r.ref !== "string" || typeof r.detail !== "string") continue;
    out.push({ source: r.source, ref: r.ref, detail: r.detail });
  }
  return out;
}
