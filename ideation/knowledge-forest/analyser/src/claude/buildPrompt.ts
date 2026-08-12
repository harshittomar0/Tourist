import type { DeepDiveTopic, ForestFile, ForestKind, ForestNode } from "../types.js";

/**
 * System prompt = the taxonomy guidelines verbatim + a strict output
 * contract (+ an optional deep-dive addendum — see `--deep-dive` in
 * cli.ts). Embedding the guidelines file directly (rather than paraphrasing
 * them into code) means taxonomy-guidelines.md stays the single source of
 * truth — update that file and every future run picks up the change with
 * no code edit.
 */
export function buildSystemPrompt(guidelinesMarkdown: string, deepDiveTopics: DeepDiveTopic[] = []): string {
  const base = buildBaseSystemPrompt(guidelinesMarkdown);
  return deepDiveTopics.length === 0 ? base : base + buildDeepDiveAddendum(deepDiveTopics);
}

function buildBaseSystemPrompt(guidelinesMarkdown: string): string {
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
6. proficiency reflects the DEFINITION for that specific forest (fluency for Tech Stacks, depth for CS Fundamentals, consistency for Engineering Practice) — re-read the relevant section of the guidelines above before scoring, don't apply one meaning across all three.

## Existing forest state — read before proposing anything

The user message includes a snapshot of the categories that already exist in this person's forest, each tagged with its current provenance. This is not evidence you cite — it's context for what NOT to invent a duplicate of, and what to actively look for fresh evidence about:

7. Reuse the EXACT existing label whenever you're clearly talking about a category that's already listed (this is rule 4 above, restated because it only works if you've actually read the snapshot) — never rename it, never propose a near-duplicate with slightly different wording.
8. Existing categories tagged "confirmed" or "gap" are the human's final word on proficiency. Do not spend effort re-assessing their proficiency — any change you propose for one is discarded by the merge step regardless of what you send. You MAY still propose new "children" or "latent" sub-topics under them if this bundle's evidence supports one that isn't listed yet (e.g. a new Django feature under an already-confirmed "Django").
9. Existing categories tagged "tracked" were added by the human directly, with no AI-assessed proficiency behind them yet. If anything in this evidence bundle relates to a "tracked" category, treat it like any other node you're proposing: look for the evidence and propose an updated proficiency, evidence, and any new children — using its exact label. This update DOES take effect (it replaces the placeholder), unlike confirmed/gap.
10. Existing categories tagged "ai" are prior guesses from an earlier run of this same pipeline — update them the same way you would a "tracked" category if you find relevant evidence; if you find nothing new about one, just leave it out of your response rather than re-emitting an unchanged guess.
11. Don't limit yourself to categories in the snapshot — this bundle's evidence can and should still produce genuinely new categories the snapshot has no entry for, per the taxonomy guidelines. The snapshot's job is to stop you from re-deriving or duplicating what's already there, not to cap what you look for.`;
}

/**
 * Appended to the base system prompt only when --deep-dive named at least
 * one topic that resolved against the existing forest (see
 * forest/deepDive.ts). Everything not listed here should stay at the
 * pipeline's normal shallow depth — this section exists to lift the depth
 * bar for a handful of categories, not to change the bar for all of them.
 */
function buildDeepDiveAddendum(topics: DeepDiveTopic[]): string {
  const topicLines = topics.map((t) => `- [${t.forestKind}] ${t.path.join(" > ")}`).join("\n");
  return `

## Deep dive requested — read this before you start

The human has asked for a DEEP DIVE on these specific existing categories:

${topicLines}

For ONLY these categories (and their existing subtree): go well beyond the standard shallow pass. Produce a much more detailed, subtopic-level breakdown — more "children" entries, at finer granularity than you'd normally propose for a category at this level — and more specific, granular "evidence" citations per node (name the specific function, line range, or exchange within a file/commit/transcript, not just "seen in commit X") than the standard pass would use.

Every other category — anything not listed above, including new ones you discover from this bundle's evidence — stays at the pipeline's normal shallow depth. Do not apply this deep-dive level of detail everywhere; that would blow past the evidence and token budget for no reason.`;
}

export interface EvidenceItem {
  source: "git" | "attribution" | "prompt";
  ref: string;
  detail: string;
  content: string;
}

const EMPTY_FOREST: ForestFile = { tech: [], cs: [], practice: [] };

/**
 * Renders the existing forest (label/provenance/proficiency only — no
 * evidence blobs, those aren't needed for the model to know what already
 * exists) so the model can see what's already in the tree instead of
 * classifying blind every run. Scoped to `forestKindsInScope` only, same as
 * the evidence bundle, and left un-truncated by `truncateEvidence` — this
 * summary is structurally important context, not raw evidence, and forests
 * are expected to stay small relative to the evidence budget (see
 * truncateEvidence's docstring for the analogous evidence-side tradeoff).
 * `latent` stubs are deliberately omitted: they're unevidenced speculation
 * from a prior run, not something the model needs to avoid duplicating.
 */
export function renderExistingForest(forestKindsInScope: ForestKind[], forest: ForestFile = EMPTY_FOREST): string {
  const sections = forestKindsInScope
    .map((kind) => {
      const nodes = forest[kind] ?? [];
      if (nodes.length === 0) return null;
      return `${kind}:\n${nodes.map((n) => renderExistingNode(n, 1)).join("\n")}`;
    })
    .filter((s): s is string => s !== null);

  if (sections.length === 0) {
    return "(No existing categories yet in the forests in scope for this run — everything you propose will be genuinely new.)";
  }
  return sections.join("\n");
}

function renderExistingNode(node: ForestNode, depth: number): string {
  const indent = "  ".repeat(depth);
  const line = `${indent}- ${node.label} [${node.provenance}, proficiency ${node.proficiency}]`;
  const children = node.children.map((c) => renderExistingNode(c, depth + 1));
  return [line, ...children].join("\n");
}

/**
 * Renders one evidence bundle into the user-message text. Kept as plain,
 * clearly-delimited sections rather than fancy formatting — the model
 * just needs to be able to tell where one piece of evidence ends and the
 * next begins, and cite `ref` back accurately.
 */
export function buildUserContent(
  forestKindsInScope: ForestKind[],
  items: EvidenceItem[],
  existingForest: ForestFile = EMPTY_FOREST
): string {
  const header = `Classify the evidence below into these forests only: ${forestKindsInScope.join(", ")}. Omit the other forest keys entirely from your response (empty array is fine, but prefer omitting if truly nothing applies).\n\n`;
  const existingSection = `<existing-forest>\n${renderExistingForest(forestKindsInScope, existingForest)}\n</existing-forest>\n\n`;
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
  return header + existingSection + body;
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
