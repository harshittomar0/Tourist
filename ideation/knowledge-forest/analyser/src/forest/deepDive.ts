import type { DeepDiveTopic, ForestFile, ForestKind, ForestNode } from "../types.js";

const FOREST_KINDS: ForestKind[] = ["tech", "cs", "practice"];

export interface DeepDiveResolution {
  resolved: DeepDiveTopic[];
  /** Requested strings (trimmed, as typed) that matched no node in any forest — the run continues, these are just reported. */
  notFound: string[];
}

/**
 * Resolves the --deep-dive flag's raw comma-separated label/path strings
 * against the *existing* forest (data/forest.json before this run), so the
 * CLI can tell the model exactly which already-known categories to expand
 * and can report which requested labels don't exist yet, rather than
 * failing the whole run over one typo — see cli.ts's handling of
 * `notFound`.
 *
 * Each entry is either a bare label ("Django") — matched anywhere in the
 * tree, at any depth — or a ">"-separated chain ("Django > ORM &
 * migrations") for disambiguating a label that appears more than once. A
 * chain doesn't need to start at a forest root: "ORM & migrations" alone is
 * enough when that label is unambiguous; the "Django >" prefix is only
 * needed to pick a specific one among duplicates.
 */
export function resolveDeepDiveTopics(requested: string[], forest: ForestFile): DeepDiveResolution {
  const resolved: DeepDiveTopic[] = [];
  const notFound: string[] = [];
  const seen = new Set<string>();

  for (const raw of requested) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;

    const path = trimmed
      .split(">")
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);
    if (path.length === 0) continue;

    const forestKind = FOREST_KINDS.find((kind) => containsChain(forest[kind], path));
    if (!forestKind) {
      notFound.push(trimmed);
      continue;
    }

    const key = `${forestKind}:${path.join(">")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    resolved.push({ forestKind, path });
  }

  return { resolved, notFound };
}

/**
 * True if `nodes` contains a contiguous parent-to-child label chain
 * matching `path`, starting anywhere in the tree — not only at the top
 * level, so a nested label can be requested on its own.
 */
function containsChain(nodes: ForestNode[], path: string[]): boolean {
  for (const n of nodes) {
    if (n.label === path[0] && (path.length === 1 || containsChain(n.children, path.slice(1)))) {
      return true;
    }
    if (containsChain(n.children, path)) return true;
  }
  return false;
}
