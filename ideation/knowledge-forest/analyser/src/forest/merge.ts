import type { ForestFile, ForestNode } from "../types.js";

/**
 * Merges a fresh analysis run into the existing forest, per
 * taxonomy-guidelines.md's provenance rule:
 *  - "confirmed" and "gap" nodes are the human's decision. Never touched —
 *    not proficiency, not evidence, not children. A new AI run that
 *    disagrees with a human-confirmed node is simply wrong for this run;
 *    it doesn't get to overwrite the record.
 *  - "tracked" nodes are also human-labeled (typically added directly in
 *    the UI, with no prior AI proposal) but — unlike "confirmed" — carry no
 *    assessed proficiency yet. proficiency/evidence/children/latent DO
 *    update from a fresh matching "ai" guess, same as a plain "ai" node
 *    would; only the label and the "tracked" provenance itself are frozen,
 *    so the category can't be silently renamed or reclassified out from
 *    under the human who declared it. See types.ts for the full rationale.
 *  - "ai" nodes ARE allowed to update fully: this run's fresher inference
 *    replaces the previous ai-provenance guess for that label, since an
 *    unconfirmed guess is exactly what's supposed to improve over time.
 *  - A label with no match in `existing` is a genuinely new node —
 *    appended as "ai".
 *  - Matching is by exact label at each level (see buildPrompt.ts rule 4 —
 *    this is *why* the model is instructed to reuse exact existing labels).
 *  - Nothing is ever deleted. A node the incoming run didn't mention simply
 *    isn't touched — silence isn't evidence the skill went away.
 */
export function mergeForest(existing: ForestFile, incoming: ForestFile): ForestFile {
  return {
    tech: mergeNodeList(existing.tech, incoming.tech),
    cs: mergeNodeList(existing.cs, incoming.cs),
    practice: mergeNodeList(existing.practice, incoming.practice)
  };
}

function mergeNodeList(existing: ForestNode[], incoming: ForestNode[]): ForestNode[] {
  const merged = existing.map((node) => ({ ...node }));

  for (const incomingNode of incoming) {
    const idx = merged.findIndex((n) => n.label === incomingNode.label);
    if (idx === -1) {
      merged.push(incomingNode);
      continue;
    }

    const current = merged[idx];
    if (current.provenance === "confirmed" || current.provenance === "gap") {
      // Human decision stands. Still recurse into children/latent so a
      // *new sub-node* under a confirmed parent can still be proposed —
      // confirming "Django" doesn't confirm every framework feature
      // Django might grow in the future.
      merged[idx] = {
        ...current,
        children: mergeNodeList(current.children, incomingNode.children),
        latent: mergeNodeList(current.latent, incomingNode.latent)
      };
      continue;
    }

    if (current.provenance === "tracked") {
      // Label and "tracked" status stand; proficiency/evidence track the
      // fresh guess exactly like an "ai" node would (see types.ts).
      merged[idx] = {
        ...current,
        proficiency: incomingNode.proficiency,
        evidence: incomingNode.evidence,
        children: mergeNodeList(current.children, incomingNode.children),
        latent: mergeNodeList(current.latent, incomingNode.latent)
      };
      continue;
    }

    // current.provenance === "ai": this run's guess supersedes the old one.
    merged[idx] = {
      ...incomingNode,
      children: mergeNodeList(current.children, incomingNode.children),
      latent: mergeNodeList(current.latent, incomingNode.latent)
    };
  }

  return merged;
}
