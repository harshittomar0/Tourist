/**
 * Serializes async tasks that share the same string key while letting tasks
 * under different keys run fully concurrently.
 *
 * Exists to stop concurrent `persistDoc` calls in extension.ts from racing
 * `PersistenceManager.record`'s load-merge-save cycle (src/persistence/
 * index.ts) against each other: `record` reads the on-disk store, merges
 * ranges in memory, then writes the whole store back, with no locking of its
 * own. Two documents that resolve to the *same* (repoRoot, branch)
 * persistence key -- routine for a multi-root workspace, or simply closing
 * several files in one repo/branch at once -- previously could both read the
 * same pre-save store, merge independently, and have the second write clobber
 * the first's entries. Chaining same-key saves through this queue makes each
 * one observe the previous one's completed write before it loads, without
 * serializing unrelated (different-repo/branch) saves against each other.
 */
import type { RepoBranchKey } from "./contracts.ts";

/** `::` can't appear in a git branch name, so a repoRoot/branch pair can't
 * collide with a different pair the way a plain space delimiter could
 * (e.g. repoRoot `/a`, branch `b c` vs. repoRoot `/a b`, branch `c`). */
export function repoBranchQueueKey(key: RepoBranchKey): string {
  return `${key.repoRoot}::${key.branch}`;
}

export class KeyedSerialQueue {
  private readonly tailByKey = new Map<string, Promise<void>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previousTail = this.tailByKey.get(key) ?? Promise.resolve();
    const result = previousTail.then(task, task);
    // Swallow the outcome for chaining purposes only -- a failed task must
    // still unblock the next queued task for this key, not wedge it forever.
    this.tailByKey.set(
      key,
      result.then(
        () => undefined,
        () => undefined
      )
    );
    return result;
  }
}
