/**
 * Hand-written fake implementing `PersistenceLike` (contracts.ts), so
 * `extension.ts` and the workspace-view can be built and tested without
 * Agent B's real `src/persistence/` module existing yet.
 *
 * Mode-toggle behavior deliberately follows GOAL1.md over PLAN1.md's Part 2
 * contract paragraph -- flagged explicitly in the final report as a real
 * conflict between the two documents, not a simplification of one
 * consistent spec:
 *   - PLAN1.md Part 2 §4 says the *entire* git-notes API ("write a note...;
 *     read a note...; push...; fetch...") is "Mode B only; all are no-ops
 *     when the mode toggle is off."
 *   - GOAL1.md's locked scope says notes are "written locally via git
 *     plumbing regardless of the toggle" and the toggle ("tourist.
 *     shareAttribution") only gates whether the ref is ever pushed/fetched
 *     to/from a remote.
 * This mock implements GOAL1.md's version (write/read always active
 * locally; push/fetch gated) since GOAL1.md is the more specific, locked
 * document and the leak-check row in Phase 4 ("zero git-notes-related
 * behavior, network calls, or side effects" when off) only makes sense
 * against network operations, not local object-store writes. Agent B should
 * confirm this reading when building the real module.
 */
import type { AttributedRange, AttributionNotePayload, PersistenceLike, RepoBranchKey, VscodeUriLike } from "../contracts.ts";

interface StoredEntry {
  contentHash: string;
  ranges: AttributedRange[];
}

export interface MockPersistenceOptions {
  /** Mirrors "Mode toggle: ... read by Agent B's module itself" -- Agent
   * C's settings UI only ever flips `tourist.shareAttribution`; this mock
   * reads that same boolean itself rather than being told per-call. */
  shareAttributionEnabled?: boolean;
  /** Real resolution goes through the `vscode.git` extension API with a
   * raw-filesystem worktree-aware fallback (Agent B's job). The mock takes
   * an injectable resolver so tests can control (repoRoot, branch) without
   * a real git repo or the `vscode` module present. */
  resolveKeyImpl?: (uri: VscodeUriLike) => Promise<RepoBranchKey>;
}

function defaultResolveKey(uri: VscodeUriLike): Promise<RepoBranchKey> {
  const fsPath = uri.fsPath;
  const lastSep = Math.max(fsPath.lastIndexOf("/"), fsPath.lastIndexOf("\\"));
  return Promise.resolve({ repoRoot: lastSep >= 0 ? fsPath.slice(0, lastSep) : fsPath, branch: "(mock-branch)" });
}

const KEY_PARTS_SEPARATOR = " ";

export class MockPersistence implements PersistenceLike {
  shareAttributionEnabled: boolean;
  private readonly resolveKeyImpl: (uri: VscodeUriLike) => Promise<RepoBranchKey>;
  private readonly store = new Map<string, StoredEntry>();
  private readonly notes = new Map<string, AttributionNotePayload>();

  /** Recorded calls, exposed for test assertions (e.g. the mode-off
   * leak-check row: assert this stays empty with the toggle off). */
  readonly pushCalls: string[] = [];
  readonly fetchCalls: string[] = [];

  constructor(options: MockPersistenceOptions = {}) {
    this.shareAttributionEnabled = options.shareAttributionEnabled ?? false;
    this.resolveKeyImpl = options.resolveKeyImpl ?? defaultResolveKey;
  }

  private storeKey(docId: string, key: RepoBranchKey): string {
    return [key.repoRoot, key.branch, docId].join(KEY_PARTS_SEPARATOR);
  }

  private keyPrefix(key: RepoBranchKey): string {
    return [key.repoRoot, key.branch, ""].join(KEY_PARTS_SEPARATOR);
  }

  async load(docId: string, contentHash: string, key: RepoBranchKey): Promise<AttributedRange[] | undefined> {
    const entry = this.store.get(this.storeKey(docId, key));
    if (!entry || entry.contentHash !== contentHash) return undefined;
    return entry.ranges.slice();
  }

  async save(docId: string, contentHash: string, key: RepoBranchKey, ranges: AttributedRange[]): Promise<void> {
    this.store.set(this.storeKey(docId, key), { contentHash, ranges: ranges.slice() });
  }

  async resolveKey(uri: VscodeUriLike): Promise<RepoBranchKey> {
    return this.resolveKeyImpl(uri);
  }

  async rename(oldDocId: string, newDocId: string): Promise<void> {
    const suffix = KEY_PARTS_SEPARATOR + oldDocId;
    for (const [storedKey, entry] of [...this.store.entries()]) {
      if (!storedKey.endsWith(suffix)) continue;
      this.store.delete(storedKey);
      this.store.set(storedKey.slice(0, -oldDocId.length) + newDocId, entry);
    }
  }

  async listPersisted(key: RepoBranchKey): Promise<Array<{ docId: string; ranges: AttributedRange[] }>> {
    const prefix = this.keyPrefix(key);
    const results: Array<{ docId: string; ranges: AttributedRange[] }> = [];
    for (const [storedKey, entry] of this.store.entries()) {
      if (!storedKey.startsWith(prefix)) continue;
      results.push({ docId: storedKey.slice(prefix.length), ranges: entry.ranges.slice() });
    }
    return results;
  }

  // -- Git-notes API (see class doc comment re: PLAN1.md/GOAL1.md conflict) --

  async writeNote(commitSha: string, payload: AttributionNotePayload): Promise<void> {
    this.notes.set(commitSha, payload);
  }

  async readNote(commitSha: string): Promise<AttributionNotePayload | undefined> {
    return this.notes.get(commitSha);
  }

  async pushNotes(remote: string): Promise<void> {
    if (!this.shareAttributionEnabled) return;
    this.pushCalls.push(remote);
  }

  async fetchNotes(remote: string): Promise<void> {
    if (!this.shareAttributionEnabled) return;
    this.fetchCalls.push(remote);
  }
}
