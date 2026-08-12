import type { ForestKind } from "../types.js";

/**
 * System prompt = the taxonomy guidelines verbatim + a strict output
 * contract. Embedding the guidelines file directly (rather than
 * paraphrasing them into code) means taxonomy-guidelines.md stays the
 * single source of truth — update that file and every future run picks up
 * the change with no code edit.
 */
export function buildSystemPrompt(guidelinesMarkdown: string): string {
  return `You are the classification engine for a developer "knowledge forest" — three trees of skill nodes (Tech Stacks, CS Fundamentals, Engineering Practice). Your ONLY job is to read the evidence bundle in the user message and propose knowledge-forest nodes as JSON.

The taxonomy guidelines below are the authority on what belongs in each bucket, at what depth, and what "proficiency" means in each. Read them fully before classifying anything.

<taxonomy-guidelines>
${guidelinesMarkdown}
</taxonomy-guidelines>

## Output contract — read carefully, this is enforced by a validator after you respond

Respond with ONLY a JSON object, no prose before or after, no markdown code fence, matching exactly:

{
  "tech": ForestNode[],
  "cs": ForestNode[],
  "practice": ForestNode[]
}

where ForestNode is:

{
  "label": string,
  "provenance": "ai",
  "proficiency": number (0-5, integer),
  "children": ForestNode[],
  "latent": ForestNode[],
  "evidence": [{ "source": "git" | "attribution" | "prompt", "ref": string, "detail": string }]
}

Hard rules:
1. "provenance" must ALWAYS be the literal string "ai". You never emit "confirmed" or "gap" — those states are exclusively set by the human user in the UI, never inferred. If evidence is too thin to support even a low-confidence guess, omit the node entirely rather than guessing "gap": absence of evidence is not the same as a declared gap, and only a human can declare one.
2. Every node MUST include at least one "evidence" entry citing what in the input bundle produced it (a commit sha, a file path, a transcript excerpt). A node with no evidence is not allowed — if you can't cite something, don't emit it.
3. Use "children" for sub-topics you have enough evidence to name outright. Use "latent" for sub-topics you strongly suspect exist (e.g. a framework that typically has these facets) but don't yet have direct evidence for in this bundle — these render as "tap to reveal" stubs in the UI, not as claims.
4. Match existing node labels exactly (case-sensitive) when you're clearly talking about the same skill/concept/practice that's likely already in the tree (e.g. always write "Django", not "django" or "the Django framework") — the merge step matches by exact label string.
5. Do not invent evidence. If the bundle doesn't support a node, leave it out.
6. proficiency reflects the DEFINITION for that specific forest (fluency for Tech Stacks, depth for CS Fundamentals, consistency for Engineering Practice) — re-read the relevant section of the guidelines above before scoring, don't apply one meaning across all three.`;
}

export interface EvidenceItem {
  source: "git" | "attribution" | "prompt";
  ref: string;
  detail: string;
  content: string;
}

/**
 * Renders one evidence bundle into the user-message text. Kept as plain,
 * clearly-delimited sections rather than fancy formatting — the model
 * just needs to be able to tell where one piece of evidence ends and the
 * next begins, and cite `ref` back accurately.
 */
export function buildUserContent(forestKindsInScope: ForestKind[], items: EvidenceItem[]): string {
  const header = `Classify the evidence below into these forests only: ${forestKindsInScope.join(", ")}. Omit the other forest keys entirely from your response (empty array is fine, but prefer omitting if truly nothing applies).\n\n`;
  const body = items
    .map((item, i) => {
      return [
        `--- evidence ${i + 1} (${item.source}: ${item.ref}) ---`,
        item.detail,
        "",
        item.content,
        ""
      ].join("\n");
    })
    .join("\n");
  return header + body;
}

/** Rough token-budget guard — cuts the bundle down before it ever reaches the API. */
export function truncateEvidence(items: EvidenceItem[], maxTotalChars: number): EvidenceItem[] {
  const out: EvidenceItem[] = [];
  let used = 0;
  for (const item of items) {
    const cost = item.content.length + item.detail.length;
    if (used + cost > maxTotalChars) {
      const remaining = maxTotalChars - used;
      if (remaining <= 200) break; // not enough room left to be useful
      out.push({ ...item, content: item.content.slice(0, remaining) + "\n...[truncated]" });
      break;
    }
    out.push(item);
    used += cost;
  }
  return out;
}
