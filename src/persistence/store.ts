import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PersistedEntry, PersistedStore, RepoBranchKey } from "./types.js";

function slugifyBranch(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9._-]/g, "_") || "_detached";
}

function repoRootSlug(repoRoot: string): string {
  return createHash("sha256").update(repoRoot, "utf8").digest("hex").slice(0, 16);
}

export function storeFilePath(baseDir: string, key: RepoBranchKey): string {
  return join(baseDir, repoRootSlug(key.repoRoot), `${slugifyBranch(key.branch)}.json`);
}

function emptyStore(key: RepoBranchKey): PersistedStore {
  return { version: 1, repoRoot: key.repoRoot, branch: key.branch, entries: [] };
}

export class LocalStore {
  constructor(private readonly baseDir: string) {}

  async load(key: RepoBranchKey): Promise<PersistedStore> {
    const filePath = storeFilePath(this.baseDir, key);
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedStore;
      if (parsed.version !== 1) {
        // Unknown/future format: don't guess at migration, start fresh rather than corrupt.
        return emptyStore(key);
      }
      return parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return emptyStore(key);
      }
      throw err;
    }
  }

  async save(store: PersistedStore): Promise<void> {
    const filePath = storeFilePath(this.baseDir, { repoRoot: store.repoRoot, branch: store.branch });
    await mkdir(dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmpPath, JSON.stringify(store, null, 2), "utf8");
    await rename(tmpPath, filePath);
  }
}

/**
 * Upserts entries keyed by (lastSeenFsPath, range.startLine, range.endLine,
 * contentHash) -- location AND content, not content alone. A hash-only key
 * (the previous implementation) is never unique on its own: two unrelated
 * locations sharing byte-identical text (a lone "}", "return null;", a blank
 * line -- extremely common) collided and silently clobbered each other, even
 * across different files, on ordinary editing with no git involved.
 * Including the location in the key fixes that: two identical-text spans at
 * different (fsPath, line) coordinates now get different keys and both
 * survive.
 *
 * `contentHash` stays *part of* the key rather than being dropped in favor
 * of location alone, because a location's superseded content is meant to
 * remain findable, not be overwritten: `fromPersistedEntry`
 * (persistence-adapter.ts) validates each stored entry independently by
 * re-hashing whatever text currently sits at that entry's own recorded
 * line-range, so an older entry whose exact (location, content) reappears
 * later -- e.g. a `git stash pop` reverting a file back to text it had
 * before a since-discarded edit -- is exactly what lets that older
 * attribution be found and restored again. Keying on location alone would
 * have the *new* save silently overwrite that still-useful older entry
 * before the revert ever happens. Growth is bounded the same way it already
 * was pre-fix: `pruneExpired` (retention.ts) ages entries out by
 * `attribution.updatedAt`, independent of this key shape.
 *
 * On an exact (location, content) repeat -- the same span saved again with
 * unchanged text -- the incoming entry simply replaces the old one in place
 * (refreshed attribution/timestamp), same "last write wins" semantics as
 * before.
 */
export function upsertEntries(store: PersistedStore, incoming: PersistedEntry[]): PersistedStore {
  const keyOf = (e: PersistedEntry): string =>
    `${e.lastSeenFsPath}::${e.range.startLine}::${e.range.endLine}::${e.contentHash}`;

  const byKey = new Map(store.entries.map((e) => [keyOf(e), e]));
  for (const entry of incoming) {
    byKey.set(keyOf(entry), entry);
  }
  return { ...store, entries: [...byKey.values()] };
}
