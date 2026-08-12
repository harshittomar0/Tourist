import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttributionNote, AttributionNoteEntry, GitRunner } from "./types.js";

export const ATTRIBUTION_NOTES_REF = "refs/notes/tourist-attribution";

export async function readNote(
  runner: GitRunner,
  repoRoot: string,
  commitSha: string,
  ref: string = ATTRIBUTION_NOTES_REF
): Promise<AttributionNote | undefined> {
  const result = await runner(repoRoot, ["notes", `--ref=${ref}`, "show", commitSha]);
  if (result.code !== 0) return undefined; // no note on this commit — not an error
  try {
    const parsed = JSON.parse(result.stdout) as AttributionNote;
    return parsed.version === 1 ? parsed : undefined;
  } catch {
    return undefined; // a note exists but isn't ours to parse — leave it alone
  }
}

/** Lists `<objectSha>`s that have a note under `ref` (default: our own notes ref). */
export async function listNotedObjects(runner: GitRunner, repoRoot: string, ref: string = ATTRIBUTION_NOTES_REF): Promise<string[]> {
  const result = await runner(repoRoot, ["notes", `--ref=${ref}`, "list"]);
  if (result.code !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/)[1])
    .filter((sha): sha is string => Boolean(sha));
}

export async function writeNote(runner: GitRunner, repoRoot: string, commitSha: string, note: AttributionNote): Promise<void> {
  const tmpDir = await mkdtemp(join(tmpdir(), "tourist-note-"));
  const tmpFile = join(tmpDir, "note.json");
  try {
    await writeFile(tmpFile, JSON.stringify(note, null, 2), "utf8");
    const result = await runner(repoRoot, ["notes", `--ref=${ATTRIBUTION_NOTES_REF}`, "add", "-f", "-F", tmpFile, commitSha]);
    if (result.code !== 0) {
      throw new Error(`Failed to write attribution note for ${commitSha}: exit ${result.code}`);
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

const TIER_RANK = { verified: 3, inferred: 2, heuristic: 1 } as const;

function preferEntry(a: AttributionNoteEntry, b: AttributionNoteEntry): AttributionNoteEntry {
  const rankA = TIER_RANK[a.attribution.tier];
  const rankB = TIER_RANK[b.attribution.tier];
  if (rankA !== rankB) return rankA > rankB ? a : b;
  return a.attribution.updatedAt >= b.attribution.updatedAt ? a : b;
}

/**
 * Reads the existing note (if any), merges in `newEntries` by content hash —
 * higher attribution tier wins, then recency — and writes the result back.
 * This is the local (single-note) half of the "higher tier wins, then
 * recency" policy; `merge.ts` applies the same policy across two whole notes
 * during fetch reconciliation.
 */
export async function upsertNoteEntries(
  runner: GitRunner,
  repoRoot: string,
  commitSha: string,
  newEntries: AttributionNoteEntry[]
): Promise<AttributionNote> {
  const existing = await readNote(runner, repoRoot, commitSha);
  const byHash = new Map((existing?.entries ?? []).map((e) => [e.contentHash, e]));
  for (const entry of newEntries) {
    const current = byHash.get(entry.contentHash);
    byHash.set(entry.contentHash, current ? preferEntry(current, entry) : entry);
  }
  const note: AttributionNote = { version: 1, commit: commitSha, entries: [...byHash.values()] };
  await writeNote(runner, repoRoot, commitSha, note);
  return note;
}

export async function copyNote(runner: GitRunner, repoRoot: string, fromSha: string, toSha: string): Promise<boolean> {
  const result = await runner(repoRoot, ["notes", `--ref=${ATTRIBUTION_NOTES_REF}`, "copy", fromSha, toSha]);
  return result.code === 0;
}
