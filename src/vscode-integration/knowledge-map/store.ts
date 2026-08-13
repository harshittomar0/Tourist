/**
 * Reads/writes data/forest.json and applies a single webview-driven human
 * override to it. No `vscode` import -- this module is plain Node fs logic
 * so it's directly unit-testable (see test/vscode-integration/knowledge-map-store.test.ts).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { ForestFile, ForestKind, ForestNode, NodeOverrideMessage, Provenance } from "./types.ts";
import { emptyForest } from "./types.ts";

/**
 * Distinguishes "no forest.json yet" (expected on first run -- returns an
 * empty forest) from "forest.json exists but couldn't be read/parsed" (a
 * real problem -- e.g. a previous write got killed mid-file, or a merge
 * conflict landed in the file). The latter throws instead of silently
 * discarding whatever data is actually on disk; callers that need to
 * degrade gracefully in the UI (see panel.ts) catch this and surface a
 * warning rather than quietly showing an empty map as if nothing were
 * wrong.
 */
export function loadForest(forestJsonPath: string): ForestFile {
  let raw: string;
  try {
    raw = fs.readFileSync(forestJsonPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return emptyForest();
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ForestFile>;
    return {
      tech: Array.isArray(parsed.tech) ? parsed.tech : [],
      cs: Array.isArray(parsed.cs) ? parsed.cs : [],
      practice: Array.isArray(parsed.practice) ? parsed.practice : [],
    };
  } catch (err) {
    throw new Error(`forest.json at ${forestJsonPath} is not valid JSON: ${(err as Error).message}`);
  }
}

export function saveForest(forestJsonPath: string, forest: ForestFile): void {
  fs.mkdirSync(path.dirname(forestJsonPath), { recursive: true });
  fs.writeFileSync(forestJsonPath, JSON.stringify(forest, null, 2) + "\n", "utf8");
}

export type MergeForestFn = (existing: ForestFile, incoming: ForestFile) => ForestFile;

/**
 * Dynamically imports the analyser's *compiled* `mergeForest` at runtime
 * (never a static/build-time import -- see types.ts's header comment for
 * why this package stays decoupled from analyser's TypeScript sources).
 * Returns `undefined` if analyser hasn't been built yet (`npm run build`
 * inside ideation/knowledge-forest/analyser) so callers can degrade
 * gracefully instead of crashing -- see applyOverride's fallback branch.
 */
export async function loadMergeForest(analyserDir: string): Promise<MergeForestFn | undefined> {
  const mergeJsPath = path.join(analyserDir, "dist", "forest", "merge.js");
  if (!fs.existsSync(mergeJsPath)) return undefined;
  try {
    const mod: unknown = await import(pathToFileURL(mergeJsPath).href);
    const fn = (mod as { mergeForest?: unknown }).mergeForest;
    return typeof fn === "function" ? (fn as MergeForestFn) : undefined;
  } catch {
    return undefined;
  }
}

function findByPath(nodes: ForestNode[], labelPath: string[]): ForestNode | undefined {
  if (labelPath.length === 0) return undefined;
  const [label, ...rest] = labelPath;
  const node = nodes.find((n) => n.label === label);
  if (!node) return undefined;
  if (rest.length === 0) return node;
  return findByPath(node.children, rest) ?? findByPath(node.latent, rest);
}

function findParentList(roots: ForestNode[], labelPath: string[]): { list: ForestNode[]; index: number } | undefined {
  if (labelPath.length === 0) return undefined;
  if (labelPath.length === 1) {
    const index = roots.findIndex((n) => n.label === labelPath[0]);
    return index === -1 ? undefined : { list: roots, index };
  }
  const parent = findByPath(roots, labelPath.slice(0, -1));
  if (!parent) return undefined;
  const label = labelPath[labelPath.length - 1];
  const childIndex = parent.children.findIndex((n) => n.label === label);
  if (childIndex !== -1) return { list: parent.children, index: childIndex };
  const latentIndex = parent.latent.findIndex((n) => n.label === label);
  return latentIndex === -1 ? undefined : { list: parent.latent, index: latentIndex };
}

/** Nests `target` under placeholder ancestor nodes matching `path`'s labels,
 * so `mergeForest`'s label-matching recursion can find the real ancestors
 * already on disk and drill down to `target` without disturbing siblings
 * (an ancestor with no match in `incoming` is left untouched by
 * mergeForest, never deleted -- see merge.ts's own contract comment). */
function buildSingleNodeDelta(kind: ForestKind, labelPath: string[], target: ForestNode): ForestFile {
  let node = target;
  for (let i = labelPath.length - 2; i >= 0; i--) {
    node = { label: labelPath[i], provenance: "ai", proficiency: 0, children: [node], latent: [] };
  }
  const delta = emptyForest();
  delta[kind] = [node];
  return delta;
}

export interface ApplyResult {
  forest: ForestFile;
  changed: boolean;
  usedMerge: boolean;
  /** Set instead of applying the edit when the requested change was rejected
   * as invalid (e.g. a duplicate sibling label) rather than merely
   * unresolvable -- see applyOverride's addChild/rename branches. Callers
   * (panel.ts) surface this to the user instead of silently no-oping. */
  error?: string;
}

/** True if `list` already has a node with `label`, other than the node at
 * `excludeIndex` (used by rename, which is renaming a node already in the
 * list). Node identity within a single level is label-based throughout this
 * codebase (findByPath, mergeNodeList, containsChain all match siblings by
 * label alone), so this is the one gate that keeps that assumption valid:
 * without it, a user could create two same-labeled siblings from the UI and
 * every one of those label-lookups would silently act on the wrong node. */
function hasSiblingWithLabel(list: ForestNode[], label: string, excludeIndex?: number): boolean {
  return list.some((n, i) => n.label === label && i !== excludeIndex);
}

/**
 * Applies one human override from the webview directly to `forest` (mutates
 * and returns it) or, for the confirm/reject/proficiency transition on a
 * still-"ai" node, via the analyser's real `mergeForest` when available.
 *
 * Why not always call mergeForest: its contract (merge.ts) is "confirmed/gap
 * nodes are the human's decision, never touched by a later run" -- built to
 * stop a fresh *analyser* pass from clobbering a human decision. Naively
 * routing every webview edit through it would misapply that same rule to
 * the human's own follow-up edits (e.g. nudging the proficiency dial again
 * after already confirming a node), which is never mergeForest's intent and
 * would just make re-edits silently no-op. So: once a node is already
 * `confirmed`/`gap`, this applies the edit directly (the human owns it
 * outright); the ai -> confirmed/gap transition is the one case that's
 * genuinely "reconcile a fresh guess against the existing forest", and that
 * one goes through the real mergeForest so the contract stays exercised for
 * real rather than reimplemented by hand here. rename/addChild/delete have
 * no equivalent in mergeForest's model at all (it never renames or
 * deletes), so those are always direct structural edits.
 */
export function applyOverride(forest: ForestFile, msg: NodeOverrideMessage, merge: MergeForestFn | undefined): ApplyResult {
  const kind = msg.forest;
  const roots = forest[kind];

  if (msg.action === "addChild") {
    const label = String(msg.value ?? "").trim();
    if (!label) return { forest, changed: false, usedMerge: false };
    const newNode: ForestNode = { label, provenance: "confirmed", proficiency: 1, children: [], latent: [] };
    if (msg.path.length === 0) {
      if (hasSiblingWithLabel(roots, label)) {
        return { forest, changed: false, usedMerge: false, error: `"${label}" already exists at the top level.` };
      }
      roots.push(newNode);
    } else {
      const parent = findByPath(roots, msg.path);
      if (!parent) return { forest, changed: false, usedMerge: false };
      if (hasSiblingWithLabel(parent.children, label)) {
        return { forest, changed: false, usedMerge: false, error: `"${label}" already exists under "${parent.label}".` };
      }
      parent.children.push(newNode);
    }
    return { forest, changed: true, usedMerge: false };
  }

  if (msg.action === "delete") {
    const loc = findParentList(roots, msg.path);
    if (!loc) return { forest, changed: false, usedMerge: false };
    loc.list.splice(loc.index, 1);
    return { forest, changed: true, usedMerge: false };
  }

  if (msg.action === "rename") {
    const target = findByPath(roots, msg.path);
    const newLabel = String(msg.value ?? "").trim();
    if (!target || !newLabel || newLabel === target.label) return { forest, changed: false, usedMerge: false };
    const loc = findParentList(roots, msg.path);
    if (loc && hasSiblingWithLabel(loc.list, newLabel, loc.index)) {
      return { forest, changed: false, usedMerge: false, error: `"${newLabel}" already exists at this level.` };
    }
    target.label = newLabel;
    return { forest, changed: true, usedMerge: false };
  }

  // confirm / reject / proficiency
  const existing = findByPath(roots, msg.path);
  const nextProvenance: Provenance = msg.action === "reject" ? "gap" : "confirmed";
  const nextProficiency =
    msg.action === "reject" ? 0 : typeof msg.value === "number" ? msg.value : existing?.proficiency ?? 1;

  if (existing && (existing.provenance === "confirmed" || existing.provenance === "gap")) {
    existing.provenance = nextProvenance;
    existing.proficiency = nextProficiency;
    return { forest, changed: true, usedMerge: false };
  }

  if (!merge) {
    // analyser not built yet -- direct write; only the merge-based
    // protection against a *concurrently running* analyser CLI overwriting
    // this same edit is unavailable until `npm run build` has been run
    // inside analyser/.
    if (!existing) return { forest, changed: false, usedMerge: false };
    existing.provenance = nextProvenance;
    existing.proficiency = nextProficiency;
    return { forest, changed: true, usedMerge: false };
  }

  const targetLabel = msg.path[msg.path.length - 1];
  const incomingNode: ForestNode = {
    label: targetLabel,
    provenance: nextProvenance,
    proficiency: nextProficiency,
    children: existing?.children ?? [],
    latent: existing?.latent ?? [],
    evidence: existing?.evidence,
  };
  const incoming = buildSingleNodeDelta(kind, msg.path, incomingNode);
  const merged = merge(forest, incoming);
  return { forest: merged, changed: true, usedMerge: true };
}
