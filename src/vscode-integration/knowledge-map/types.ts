/**
 * Local, decoupled mirror of ideation/knowledge-forest/analyser/src/types.ts's
 * persisted schema. Deliberately duplicated rather than imported: the
 * analyser package is a self-contained spike with its own build (see
 * PLAN.md's "Scope boundary" -- "never added to the root tourist package's
 * dependencies or build"), and this shape is small and stable enough that
 * hand-syncing it here is cheaper than coupling this extension's compile to
 * a sibling package's TypeScript sources.
 */
export type Provenance = "confirmed" | "ai" | "gap" | "tracked";
export type ForestKind = "tech" | "cs" | "practice";

export interface ForestEvidence {
  source: "git" | "attribution" | "prompt";
  ref: string;
  detail: string;
}

export interface ForestNode {
  label: string;
  provenance: Provenance;
  proficiency: number;
  children: ForestNode[];
  latent: ForestNode[];
  evidence?: ForestEvidence[];
}

export interface ForestFile {
  tech: ForestNode[];
  cs: ForestNode[];
  practice: ForestNode[];
}

export function emptyForest(): ForestFile {
  return { tech: [], cs: [], practice: [] };
}

/** A single node override made by a human in the webview (confirm/reject a
 * proficiency dial, rename, add a child, or delete) -- see html.ts's
 * injected bridge script for how `path` (a label path from the forest's
 * root down to the target node) is derived purely from the rendered DOM,
 * without needing anything from the original ui/knowledge-forest.html
 * script's private closures. */
export type OverrideAction = "confirm" | "reject" | "proficiency" | "rename" | "addChild" | "delete";

export interface NodeOverrideMessage {
  type: "nodeOverride";
  forest: ForestKind;
  /** For every action except `addChild`, the full label path to the target
   * node. For `addChild`, the label path to the *parent* (or `[]` for a new
   * root/stack). */
  path: string[];
  action: OverrideAction;
  value?: string | number;
}

/** Sent when the user selects one or more existing topic nodes in the tree
 * and clicks "Deep Dive on Selected" -- see html.ts's injected checkbox
 * affordance. `topics` are bare labels (matching the analyser CLI's planned
 * `--deep-dive label1,label2,...` flag), not full paths. */
export interface DeepDiveMessage {
  type: "deepDive";
  topics: string[];
}

/** Sent when the user clicks the "Re-review" affordance on a single
 * confirmed/gap node -- see html.ts's injected bridge script. `topic` is the
 * node's FULL root-to-node ancestor path, ">"-joined (e.g.
 * "Django > ORM & migrations"), matching the analyser CLI's
 * `--reopen path1,path2,...` chain syntax (see
 * ideation/knowledge-forest/analyser/src/forest/deepDive.ts's
 * resolveDeepDiveTopics). Unlike `DeepDiveMessage.topics` (bare labels --
 * deep dive is purely informational for the prompt and doesn't need to
 * disambiguate), this one MUST be the full path: forest/merge.ts's
 * mergeNodeList matches --reopen targets against the full ancestor path
 * built during tree traversal, so a bare label only matches a root-level
 * node and silently no-ops for anything nested.
 * This is an explicit, one-time opt-in: it does not change the node's
 * stored provenance, it only lets this one analyser run's fresh guess update
 * that node's proficiency/evidence (see ideation/knowledge-forest/analyser/src/forest/merge.ts's
 * ReopenTarget handling). Without the user re-reviewing again on a later
 * run, the node goes back to being fully frozen. */
export interface ReopenNodeMessage {
  type: "reopenNode";
  topic: string;
}

/** Sent whenever the user changes the theme dropdown, so the extension host
 * can carry the choice forward into the next `buildKnowledgeMapHtml` call --
 * see html.ts's injected bridge script. Without this, panel.ts's `render()`
 * would silently reset the theme to the raw file's hardcoded default on
 * every subsequent nodeOverride/deepDive round trip. */
export interface ThemeChangedMessage {
  type: "themeChanged";
  theme: string;
}

export type WebviewToExtensionMessage = NodeOverrideMessage | DeepDiveMessage | ReopenNodeMessage | ThemeChangedMessage;
