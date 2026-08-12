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
 * Upserts entries keyed by content hash (the whole point: identity survives
 * fsPath changes). On a hash collision the incoming entry wins, matching
 * "last write wins" for same-content ranges.
 */
export function upsertByContentHash(store: PersistedStore, incoming: PersistedEntry[]): PersistedStore {
  const byHash = new Map(store.entries.map((e) => [e.contentHash, e]));
  for (const entry of incoming) {
    byHash.set(entry.contentHash, entry);
  }
  return { ...store, entries: [...byHash.values()] };
}
