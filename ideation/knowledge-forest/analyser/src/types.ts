/**
 * Persisted knowledge-forest schema. Deliberately excludes `id` and
 * `expanded` — those are UI-runtime concerns that ui/knowledge-forest.html
 * assigns fresh on every load. This is the wire/storage format only.
 *
 * Provenance rule (see ../taxonomy-guidelines.md, "Cross-cutting rules"):
 * this pipeline may only ever produce "ai". "confirmed" and "gap" are
 * exclusively human-generated, via the UI's confirm/reject/dot-click
 * actions. validate.ts enforces this on every node the model returns.
 */
export type Provenance = "confirmed" | "ai" | "gap";

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
