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

/**
 * Resolves one dominant (origin, tier) per line from possibly sub-line-
 * granular offset ranges, character-weighted (the origin covering the most
 * characters of that line wins; ties broken by the later timestamp).
 *
 * Required because the persisted schema is strictly whole-line (v1's locked
 * scope, see this file's header comment): two *different*-origin ranges that
 * share a line -- routine for a live per-keystroke engine, e.g. a human
 * tweaking one character in the middle of an AI-written line -- previously
 * each rounded independently to the *same* {startLine, endLine} span, and
 * `toPersistenceRange` hashed the identical whole-line text for both,
 * producing two `PersistedEntry`s with an identical `contentHash`.
 * `upsertByContentHash` (store.ts) keys by that hash, so the later range in
 * array order silently clobbered the earlier one for that line -- observed
 * live as a `git stash` round trip on an already-attributed file collapsing
 * a mixed human/ai line entirely into one origin, and getting worse on
 * repeated cycles as which range landed last kept shifting. Resolving one
 * winner per line *before* building persistence ranges means at most one
 * entry -- and one contentHash -- is ever produced per line, so the
 * collision can't happen.
 */
function resolveLineOrigins(
  ranges: readonly AttributedRange[],
  offsets: readonly number[]
): Array<{ origin: Origin; tier: Tier | null; timestamp: number } | undefined> {
  const lineCount = Math.max(0, offsets.length - 1);
  const tallyByLine = new Map<number, Map<string, { origin: Origin; tier: Tier | null; timestamp: number; length: number }>>();

  for (const range of ranges) {
    if (range.origin === null || range.endOffset <= range.startOffset) continue;
    const startLine = offsetToLine(offsets, range.startOffset);
    const endLine = offsetToLine(offsets, Math.max(range.startOffset, range.endOffset - 1));
    for (let line = startLine; line <= endLine; line++) {
      const lineStart = offsets[line];
      const lineEnd = offsets[line + 1] ?? currentTextLength(offsets);
      const overlapLength = Math.min(range.endOffset, lineEnd) - Math.max(range.startOffset, lineStart);
      if (overlapLength <= 0) continue;
      let perLine = tallyByLine.get(line);
      if (!perLine) {
        perLine = new Map();
        tallyByLine.set(line, perLine);
      }
      const key = `${range.origin}:${range.tier ?? ""}`;
      const existing = perLine.get(key);
      if (existing) {
        existing.length += overlapLength;
        if (range.timestamp > existing.timestamp) existing.timestamp = range.timestamp;
      } else {
        perLine.set(key, { origin: range.origin, tier: range.tier, timestamp: range.timestamp, length: overlapLength });
      }
    }
  }

  const result: Array<{ origin: Origin; tier: Tier | null; timestamp: number } | undefined> = new Array(lineCount);
  for (const [line, perLine] of tallyByLine) {
    let winner: { origin: Origin; tier: Tier | null; timestamp: number; length: number } | undefined;
    for (const candidate of perLine.values()) {
      if (
        !winner ||
        candidate.length > winner.length ||
        (candidate.length === winner.length && candidate.timestamp > winner.timestamp)
      ) {
        winner = candidate;
      }
    }
    if (winner) result[line] = { origin: winner.origin, tier: winner.tier, timestamp: winner.timestamp };
  }
  return result;
}

function currentTextLength(offsets: readonly number[]): number {
  return offsets[offsets.length - 1] ?? 0;
}

/** Merges `resolveLineOrigins`'s per-line winners into whole-line
 * `PersistenceRange`s, coalescing consecutive lines that share the same
 * (origin, tier) into a single span/entry, same as the engine's own
 * `mergeAdjacent` does for piece-table pieces. */
function toPersistenceRanges(docId: string, currentText: string, offsets: readonly number[], ranges: readonly AttributedRange[]): PersistenceRange[] {
  const lineOrigins = resolveLineOrigins(ranges, offsets);
  const result: PersistenceRange[] = [];
  let spanStart = -1;
  let spanTimestamp = 0;
  let spanKey: { origin: Origin; tier: Tier | null } | undefined;

  const flush = (endLine: number) => {
    if (spanStart === -1 || !spanKey) return;
    const text = currentText.slice(offsets[spanStart], offsets[endLine + 1] ?? currentText.length);
    result.push({
      id: randomUUID(),
      fsPath: docId,
      range: { startLine: spanStart, endLine },
      text,
      attribution: {
        author: mapOriginToAuthor(spanKey.origin),
        tier: mapToAttributionTier(spanKey.origin, spanKey.tier),
        createdAt: spanTimestamp,
        updatedAt: spanTimestamp,
      },
    });
  };

  for (let line = 0; line < lineOrigins.length; line++) {
    const winner = lineOrigins[line];
    const sameAsSpan = winner && spanKey && winner.origin === spanKey.origin && winner.tier === spanKey.tier;
    if (winner && sameAsSpan) {
      if (winner.timestamp > spanTimestamp) spanTimestamp = winner.timestamp;
      continue;
    }
    if (spanStart !== -1) flush(line - 1);
    if (winner) {
      spanStart = line;
      spanTimestamp = winner.timestamp;
      spanKey = { origin: winner.origin, tier: winner.tier };
    } else {
      spanStart = -1;
      spanKey = undefined;
    }
  }
  if (spanStart !== -1) flush(lineOrigins.length - 1);
  return result;
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
    const persistenceRanges = toPersistenceRanges(docId, currentText, offsets, ranges);
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
