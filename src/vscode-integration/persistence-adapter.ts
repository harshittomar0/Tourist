/**
 * Real `PersistenceLike` implementation wrapping Agent B's `src/persistence/`
 * (`PersistenceManager` for Mode A, `src/persistence/gitNotes/*` for Mode B),
 * replacing `mocks/mock-persistence.ts` at the extension.ts construction
 * point.
 *
 * REAL MISMATCH, reconciled here rather than papered over (see contracts.ts's
 * `PersistenceLike` doc comment for the summary): Agent B's real
 * `AttributedRange` is fsPath + **line-range** + a `verified`/`inferred`/
 * `heuristic` attribution tier, content-hash-anchored *per range*; Agent A's
 * (this file's `AttributedRange`) is **offset-range** + `ai`/`human`/
 * `external` origin + a `"1"`/`"2a"`/.../`"3"`/`"4"` tier. The two schemes
 * describe the same underlying fact (who wrote a span of text) at different
 * granularity and vocabulary. Since GOAL1.md's own locked v1 scope commits
 * to whole-*line* attribution granularity (sub-line is explicitly deferred),
 * converting offset<->line loses nothing v1 actually needs; the
 * origin<->author and tier<->attribution-tier mappings below are a genuine,
 * documented, lossy simplification (nothing in `src/vscode-integration/`
 * reads `.tier` today -- only `.origin` -- so the tier round-trip currently
 * has no observable effect, but is kept honest rather than faked).
 *
 * `load`/`save` take the document's current full text (a real, mechanical
 * widening of `PersistenceLike` beyond the original contract, added during
 * this consolidation) because per-range content-hash validation and
 * offset<->line conversion both need it; `mocks/mock-persistence.ts` ignores
 * the extra parameter (its own whole-file-hash gate never needed it).
 *
 * KNOWN UNFINISHED GAP, flagged rather than faked: `writeNote`/`readNote`
 * (write attribution for a *committed* line, read it back for a historical
 * commit) have no real caller anywhere in this codebase -- extension.ts
 * never listens for "a commit just happened," so there is no live baseline
 * text for the commit's touched file(s) to convert offsets against, and
 * neither Agent B's `AttributionNote` schema nor Agent C's
 * `AttributionNotePayload` carries a per-entry fsPath at all (a commit can
 * touch multiple files; nothing here can currently disambiguate which file a
 * note entry belongs to). The implementation below does a best-effort
 * offset-as-line conversion so the method is real and round-trips
 * self-consistently, but this is **not** a substitute for the actual
 * on-commit wiring + fsPath-aware note schema Agent B/Agent C still need to
 * design -- see the integration report.
 */
import { randomUUID } from "node:crypto";
import { lineStartOffsets } from "../core/index.ts";
import type { Origin, Tier } from "./contracts.ts";
import type {
  AttributedRange,
  AttributionNotePayload,
  PersistenceLike,
  RepoBranchKey,
  VscodeUriLike,
} from "./contracts.ts";
import { PersistenceManager, type PersistenceManagerOptions } from "../persistence/index.ts";
import type { AttributedRange as PersistenceRange, AttributionTier, PersistedEntry } from "../persistence/types.ts";
import { contentHashOf } from "../persistence/hashing.ts";
import { defaultGitRunner } from "../persistence/gitNotes/gitPlumbing.ts";
import { readNote as gitReadNote, writeNote as gitWriteNote } from "../persistence/gitNotes/notesStore.ts";
import { pushAttributionNotes, fetchAttributionNotes } from "../persistence/gitNotes/commands.ts";
import type { AttributionNote, AttributionNoteEntry } from "../persistence/gitNotes/types.ts";
import type { AttributionSharingConfig } from "../persistence/gitNotes/config.ts";

export interface RealPersistenceAdapterOptions extends Pick<PersistenceManagerOptions, "baseDir" | "retentionDays" | "vscodeGitApi"> {
  /** Read live (not cached at construction) so toggling `tourist.gitNotesSync`
   * takes effect on the next push/fetch without reconstructing the adapter. */
  gitNotesConfig: () => AttributionSharingConfig;
  /** Repo roots to fan push/fetch out across -- normally every currently-open
   * workspace folder's resolved repo root. */
  getRepoRoots: () => readonly string[];
}

function offsetToLine(offsets: readonly number[], offset: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return Math.min(lo, offsets.length - 2 < 0 ? 0 : offsets.length - 2);
}

function mapOriginToAuthor(origin: Origin): string {
  if (origin === "ai") return "claude-code";
  if (origin === "external") return "external";
  return "human";
}

function authorToOrigin(author: string): Origin {
  if (author === "claude-code") return "ai";
  if (author === "external") return "external";
  return "human";
}

/** Lossy by design -- see this file's header comment. Nothing in
 * src/vscode-integration/ currently reads `.tier`, only `.origin`. */
function mapToAttributionTier(origin: Origin, tier: Tier | null): AttributionTier {
  if (origin === "human") return "verified"; // directly observed via dirty-state, not inferred
  if (tier === "1") return "verified";
  if (tier === "2a" || tier === "2b" || tier === "2c") return "inferred";
  return "heuristic"; // "3" | "4" | null
}

function attributionTierToTier(tier: AttributionTier): Tier | null {
  if (tier === "verified") return "1";
  if (tier === "inferred") return "2a";
  return "3";
}

/** Converts one offset-based `AttributedRange` (Agent A's shape) into Agent
 * B's line-based, content-hash-anchored shape, given the document's current
 * full text. Returns `undefined` for unmarked (`origin: null`) ranges --
 * Agent B's persisted store has no concept of "unmarked," matching how
 * tourist-raw never persisted untouched content either. */
function toPersistenceRange(docId: string, currentText: string, offsets: readonly number[], range: AttributedRange): PersistenceRange | undefined {
  if (range.origin === null || range.endOffset <= range.startOffset) return undefined;
  const startLine = offsetToLine(offsets, range.startOffset);
  const endLine = offsetToLine(offsets, Math.max(range.startOffset, range.endOffset - 1));
  // Hash the same whole-line-boundary text `fromPersistedEntry` reconstructs
  // on load (offsets[startLine] .. offsets[endLine + 1]), not the range's
  // exact character substring -- the persisted `range` is line-grained
  // (RangeSpan has no column), so hashing a narrower character-precise
  // substring here would never match what load recomputes from line
  // boundaries alone, silently dropping any range that doesn't happen to
  // span whole lines (REVIEW_SENIOR.md finding #2).
  const text = currentText.slice(offsets[startLine], offsets[endLine + 1] ?? currentText.length);
  const now = range.timestamp;
  return {
    id: randomUUID(),
    fsPath: docId,
    range: { startLine, endLine },
    text,
    attribution: {
      author: mapOriginToAuthor(range.origin),
      tier: mapToAttributionTier(range.origin, range.tier),
      createdAt: now,
      updatedAt: now,
    },
  };
}

/** Reverse of `toPersistenceRange`, validating that the entry's content hash
 * still matches the text currently at its stored line-range before trusting
 * it -- a real, per-range check, not the naive whole-file-hash gate the mock
 * used. Returns `undefined` if the entry no longer matches (stale). */
function fromPersistedEntry(entry: PersistedEntry, currentText: string, offsets: readonly number[]): AttributedRange | undefined {
  const lineCount = Math.max(0, offsets.length - 1);
  if (entry.range.startLine >= lineCount) return undefined;
  const endLineClamped = Math.min(entry.range.endLine, lineCount - 1);
  const startOffset = offsets[entry.range.startLine];
  const endOffset = offsets[endLineClamped + 1] ?? currentText.length;
  const text = currentText.slice(startOffset, endOffset);
  if (contentHashOf(text) !== entry.contentHash) return undefined; // stale -- content moved/changed since this was persisted
  return {
    startOffset,
    endOffset,
    origin: authorToOrigin(entry.attribution.author),
    tier: attributionTierToTier(entry.attribution.tier),
    timestamp: entry.attribution.updatedAt,
  };
}

/** Fills any gap in a sorted, non-overlapping range list with unmarked
 * (`origin: null`) spans so the result is contiguous over `[0, length)` --
 * required by `AttributionEngine.open`'s restore contract. */
function fillGaps(sorted: AttributedRange[], length: number): AttributedRange[] {
  const out: AttributedRange[] = [];
  let cursor = 0;
  for (const r of sorted) {
    if (r.startOffset > cursor) out.push({ startOffset: cursor, endOffset: r.startOffset, origin: null, tier: null, timestamp: r.timestamp });
    out.push(r);
    cursor = r.endOffset;
  }
  if (cursor < length) out.push({ startOffset: cursor, endOffset: length, origin: null, tier: null, timestamp: Date.now() });
  return out;
}

export class RealPersistenceAdapter implements PersistenceLike {
  private readonly manager: PersistenceManager;

  constructor(private readonly options: RealPersistenceAdapterOptions) {
    this.manager = new PersistenceManager(options);
  }

  async resolveKey(uri: VscodeUriLike): Promise<RepoBranchKey> {
    const key = await this.manager.resolveKeyForFile(uri.fsPath);
    if (key) return key;
    // No .git found anywhere up the tree -- degenerate but stable key so an
    // out-of-repo file still gets *some* scoped history rather than throwing.
    return { repoRoot: uri.fsPath, branch: "(no-repo)" };
  }

  async load(docId: string, _contentHash: string, key: RepoBranchKey, currentText: string): Promise<AttributedRange[] | undefined> {
    const store = await this.manager.load(key);
    const offsets = lineStartOffsets(currentText);
    const candidates = store.entries
      .filter((e) => e.lastSeenFsPath === docId)
      .map((e) => fromPersistedEntry(e, currentText, offsets))
      .filter((r): r is AttributedRange => r !== undefined)
      .sort((a, b) => a.startOffset - b.startOffset);
    if (candidates.length === 0) return undefined;

    // Greedy non-overlap selection in start-offset order -- Agent B's model
    // anchors per-range by content hash, not position, so two persisted
    // entries for the same docId can in principle describe overlapping
    // spans after a complex edit. Earlier (lower start offset) entries win;
    // a later-starting overlapping entry is dropped rather than merged.
    const nonOverlapping: AttributedRange[] = [];
    let cursor = 0;
    for (const r of candidates) {
      if (r.startOffset < cursor) continue;
      nonOverlapping.push(r);
      cursor = r.endOffset;
    }
    return fillGaps(nonOverlapping, currentText.length);
  }

  async save(docId: string, _contentHash: string, key: RepoBranchKey, ranges: AttributedRange[], currentText: string): Promise<void> {
    const offsets = lineStartOffsets(currentText);
    const persistenceRanges = ranges
      .map((r) => toPersistenceRange(docId, currentText, offsets, r))
      .filter((r): r is PersistenceRange => r !== undefined);
    await this.manager.record(key, persistenceRanges);
  }

  async rename(oldDocId: string, newDocId: string, key: RepoBranchKey): Promise<void> {
    await this.manager.applyRenames(key, [{ oldFsPath: oldDocId, newFsPath: newDocId }]);
  }

  async listPersisted(key: RepoBranchKey): Promise<Array<{ docId: string; ranges: AttributedRange[] }>> {
    const store = await this.manager.load(key);
    const byPath = new Map<string, PersistedEntry[]>();
    for (const entry of store.entries) {
      const list = byPath.get(entry.lastSeenFsPath);
      if (list) list.push(entry);
      else byPath.set(entry.lastSeenFsPath, [entry]);
    }
    // No live document text exists for a file that was never opened this
    // session (the whole reason listPersisted exists), so real char offsets
    // are meaningless here. Per stats.ts's own documented convention
    // ("bucket lines... pass in the line count as if it were length 1 per
    // line"), synthesize one offset unit per line -- exact for the
    // aggregate ai/human/external *counts* the workspace-view/status-bar
    // actually compute, since v1's attribution granularity is whole-line.
    return [...byPath.entries()].map(([docId, entries]) => ({
      docId,
      ranges: entries.map((e) => ({
        startOffset: e.range.startLine,
        endOffset: e.range.endLine + 1,
        origin: authorToOrigin(e.attribution.author),
        tier: attributionTierToTier(e.attribution.tier),
        timestamp: e.attribution.updatedAt,
      })),
    }));
  }

  // -- Git-notes API (Mode B) ------------------------------------------

  async writeNote(commitSha: string, payload: AttributionNotePayload): Promise<void> {
    const repoRoot = this.options.getRepoRoots()[0];
    if (!repoRoot) return;
    const entries: AttributionNoteEntry[] = payload.ranges
      .filter((r) => r.origin !== null)
      .map((r) => ({
        // No live file content is available for an arbitrary historical
        // commit at this call site (see header comment) -- offsets are used
        // directly as a line-index stand-in, and the hash is over the
        // range's own numeric identity rather than real text. Self-
        // consistent for round-tripping through this adapter, but NOT a
        // substitute for real per-commit-file-content wiring.
        contentHash: contentHashOf(`${r.startOffset}:${r.endOffset}:${r.origin}:${r.tier ?? ""}`),
        range: { startLine: r.startOffset, endLine: Math.max(r.startOffset, r.endOffset - 1) },
        attribution: {
          author: mapOriginToAuthor(r.origin),
          tier: mapToAttributionTier(r.origin, r.tier),
          createdAt: r.timestamp,
          updatedAt: r.timestamp,
        },
      }));
    const note: AttributionNote = { version: 1, commit: commitSha, entries };
    await gitWriteNote(defaultGitRunner, repoRoot, commitSha, note);
  }

  async readNote(commitSha: string): Promise<AttributionNotePayload | undefined> {
    const repoRoot = this.options.getRepoRoots()[0];
    if (!repoRoot) return undefined;
    const note = await gitReadNote(defaultGitRunner, repoRoot, commitSha);
    if (!note) return undefined;
    return {
      commitSha,
      recordedAt: Math.max(0, ...note.entries.map((e) => e.attribution.updatedAt), 0),
      ranges: note.entries.map((e) => ({
        startOffset: e.range.startLine,
        endOffset: e.range.endLine + 1,
        origin: authorToOrigin(e.attribution.author),
        tier: attributionTierToTier(e.attribution.tier),
        timestamp: e.attribution.updatedAt,
      })),
    };
  }

  async pushNotes(remote: string): Promise<void> {
    const config = this.options.gitNotesConfig();
    for (const repoRoot of this.options.getRepoRoots()) {
      await pushAttributionNotes(defaultGitRunner, repoRoot, { ...config, remote });
    }
  }

  async fetchNotes(remote: string): Promise<void> {
    const config = this.options.gitNotesConfig();
    for (const repoRoot of this.options.getRepoRoots()) {
      await fetchAttributionNotes(defaultGitRunner, repoRoot, { ...config, remote });
    }
  }
}
