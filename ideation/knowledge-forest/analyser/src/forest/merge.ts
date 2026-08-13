import type { ForestFile, ForestKind, ForestNode, ReopenTarget } from "../types.js";

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
 *
 * `reopen` is the --reopen flag's resolved targets (see cli.ts and
 * forest/deepDive.ts's resolveDeepDiveTopics, reused for --reopen's
 * resolution too): a one-time, this-call-only exception list. A confirmed/
 * gap node whose exact path is in `reopen` is treated like a "tracked" node
 * for *this* merge only — proficiency/evidence update from the fresh guess,
 * but its provenance stays "confirmed"/"gap" (never rewritten to "tracked").
 * Nothing about this is persisted on the node itself, so a later call to
 * mergeForest that doesn't pass the same target again sees an ordinary
 * confirmed/gap node and freezes it fully, exactly as before — the override
 * only ever lives in this function's `reopen` argument for the run that
 * requested it.
 */
export function mergeForest(existing: ForestFile, incoming: ForestFile, reopen: ReopenTarget[] = []): ForestFile {
  const reopenKeys = new Set(reopen.map((t) => reopenKey(t.forestKind, t.path)));
  return {
    tech: mergeNodeList(existing.tech, incoming.tech, "tech", [], reopenKeys),
    cs: mergeNodeList(existing.cs, incoming.cs, "cs", [], reopenKeys),
    practice: mergeNodeList(existing.practice, incoming.practice, "practice", [], reopenKeys)
  };
}

function reopenKey(forestKind: ForestKind, path: string[]): string {
  return `${forestKind}:${path.join(">")}`;
}

function mergeNodeList(
  existing: ForestNode[],
  incoming: ForestNode[],
  kind: ForestKind,
  parentPath: string[],
  reopenKeys: Set<string>
): ForestNode[] {
  const merged = existing.map((node) => ({ ...node }));

  for (const incomingNode of incoming) {
    const idx = merged.findIndex((n) => n.label === incomingNode.label);
    const path = [...parentPath, incomingNode.label];
    if (idx === -1) {
      merged.push(incomingNode);
      continue;
    }

    const current = merged[idx];
    const isReopened = reopenKeys.has(reopenKey(kind, path));

    if ((current.provenance === "confirmed" || current.provenance === "gap") && !isReopened) {
      // Human decision stands. Still recurse into children/latent so a
      // *new sub-node* under a confirmed parent can still be proposed —
      // confirming "Django" doesn't confirm every framework feature
      // Django might grow in the future.
      merged[idx] = {
        ...current,
        children: mergeNodeList(current.children, incomingNode.children, kind, path, reopenKeys),
        latent: mergeNodeList(current.latent, incomingNode.latent, kind, path, reopenKeys)
      };
      continue;
    }

    if (current.provenance === "tracked" || isReopened) {
      // Label and provenance stand; proficiency/evidence track the fresh
      // guess exactly like an "ai" node would (see types.ts and, for the
      // reopen case, ReopenTarget's doc comment above).
      merged[idx] = {
        ...current,
        proficiency: incomingNode.proficiency,
        evidence: incomingNode.evidence,
        children: mergeNodeList(current.children, incomingNode.children, kind, path, reopenKeys),
        latent: mergeNodeList(current.latent, incomingNode.latent, kind, path, reopenKeys)
      };
      continue;
    }

    // current.provenance === "ai": this run's guess supersedes the old one.
    merged[idx] = {
      ...incomingNode,
      children: mergeNodeList(current.children, incomingNode.children, kind, path, reopenKeys),
      latent: mergeNodeList(current.latent, incomingNode.latent, kind, path, reopenKeys)
    };
  }

  return merged;
}
