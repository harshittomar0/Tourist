/**
 * Persisted knowledge-forest schema. Deliberately excludes `id` and
 * `expanded` — those are UI-runtime concerns that ui/knowledge-forest.html
 * assigns fresh on every load. This is the wire/storage format only.
 *
 * Provenance rule (see ../taxonomy-guidelines.md, "Cross-cutting rules"):
 * this pipeline may only ever produce "ai". "confirmed", "gap", and
 * "tracked" are exclusively human-generated, via the UI's
 * confirm/reject/add-node actions. validate.ts enforces this on every node
 * the model returns — the model is never allowed to claim any of the three.
 *
 * "confirmed" vs "tracked" — both are set by a human and both have a
 * human-authoritative label, but they answer different questions:
 *  - "confirmed": the human reviewed a specific proficiency/evidence
 *    assessment (almost always one the AI proposed) and signed off on it.
 *    Fully frozen — see merge.ts. There is nothing left to track; a new run
 *    disagreeing with a confirmed assessment is simply wrong for this run.
 *  - "tracked": the human declared this category exists (typically by
 *    adding it directly in the UI, with no AI proposal behind it), but its
 *    proficiency is NOT an assessed, evidence-backed value yet — it's a
 *    placeholder. Unlike "confirmed", merge.ts keeps updating a "tracked"
 *    node's proficiency/evidence/children/latent from fresh AI runs (the
 *    label itself still never changes) until a human confirms or rejects
 *    it. If the UI's "add node" action is ever wired to write real
 *    `provenance` (it currently hardcodes "confirmed" in its still-demo-only
 *    JS — see PLAN.md "Not built yet"), it should emit "tracked" instead so
 *    manually-added categories keep receiving evidence-based updates.
 */
export type Provenance = "confirmed" | "ai" | "gap" | "tracked";

export type ForestKind = "tech" | "cs" | "practice";

export interface Evidence {
  /** Where this evidence came from. */
  source: "git" | "attribution" | "prompt";
  /** Commit sha, file path, or transcript session id — whatever identifies the source record. */
  ref: string;
  /** Short human-readable note, e.g. "3 commits touching src/core/tier-classifier.ts". */
  detail: string;
}

export interface ForestNode {
  label: string;
  provenance: Provenance;
  /** 0-5. Meaning differs per forest — see taxonomy-guidelines.md. */
  proficiency: number;
  children: ForestNode[];
  latent: ForestNode[];
  /** Optional — only ever populated by the analyser, never by the UI's manual edits. */
  evidence?: Evidence[];
}

export interface ForestFile {
  tech: ForestNode[];
  cs: ForestNode[];
  practice: ForestNode[];
}

/**
 * A single --deep-dive target, resolved against the *existing* forest
 * (before this run) — see forest/deepDive.ts. `path` is the label chain as
 * matched: usually a single label, or a ">"-separated chain when the CLI
 * caller disambiguated a label that appears more than once.
 */
export interface DeepDiveTopic {
  forestKind: ForestKind;
  path: string[];
}
