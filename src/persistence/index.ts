import { toPersistedEntry } from "./hashing.js";
import { resolveGitContext } from "./gitContext.js";
import { applyRenameEvents, reconcileOrphanedEntries, type RenameEvent } from "./rekey.js";
import { pruneExpired, type RetentionOptions } from "./retention.js";
import { LocalStore, upsertEntries } from "./store.js";
import type { AttributedRange, PersistedStore, RepoBranchKey } from "./types.js";
import type { VscodeGitAPI } from "./vscodeGitTypes.js";

export * from "./types.js";
export * from "./hashing.js";
export * from "./gitContext.js";
export * from "./retention.js";
export * from "./rekey.js";
export * from "./store.js";
export * from "./branchWatcher.js";
export * from "./vscodeGitTypes.js";

export interface PersistenceManagerOptions {
  baseDir: string;
  retentionDays: number;
  vscodeGitApi?: VscodeGitAPI;
}

/**
 * Mode A public entry point: local, content-hash-anchored persistence keyed by
 * (repo root, branch).
 */
export class PersistenceManager {
  private readonly store: LocalStore;

  constructor(private readonly options: PersistenceManagerOptions) {
    this.store = new LocalStore(options.baseDir);
  }

  async resolveKeyForFile(fileFsPath: string): Promise<RepoBranchKey | undefined> {
    return resolveGitContext(fileFsPath, this.options.vscodeGitApi);
  }

  async record(key: RepoBranchKey, ranges: AttributedRange[]): Promise<PersistedStore> {
    const existing = await this.store.load(key);
    const merged = upsertEntries(existing, ranges.map(toPersistedEntry));
    const pruned = pruneExpired(merged, { retentionDays: this.options.retentionDays });
    await this.store.save(pruned);
    return pruned;
  }

  async load(key: RepoBranchKey): Promise<PersistedStore> {
    const store = await this.store.load(key);
    return pruneExpired(store, { retentionDays: this.options.retentionDays });
  }

  async applyRenames(key: RepoBranchKey, events: RenameEvent[]): Promise<PersistedStore> {
    const existing = await this.store.load(key);
    const updated = applyRenameEvents(existing, events);
    await this.store.save(updated);
    return updated;
  }

  async reconcileOrphans(key: RepoBranchKey, currentFileContents: ReadonlyMap<string, string>): Promise<PersistedStore> {
    const existing = await this.store.load(key);
    const updated = reconcileOrphanedEntries(existing, currentFileContents);
    await this.store.save(updated);
    return updated;
  }

  async prune(key: RepoBranchKey, retentionDays: RetentionOptions["retentionDays"] = this.options.retentionDays): Promise<PersistedStore> {
    const existing = await this.store.load(key);
    const pruned = pruneExpired(existing, { retentionDays });
    await this.store.save(pruned);
    return pruned;
  }
}
