/**
 * Hand-written fake implementing `EngineLike` (contracts.ts), so the rest of
 * `src/vscode-integration/` can be built and tested without Agent A's real
 * `src/core/AttributionEngine` existing yet. Deliberately a *simplified*
 * re-derivation of the real engine's documented behavior (see
 * src/core/engine.ts's own doc comments, cross-checked against this file),
 * not a byte-for-byte port -- Agent C only needs plausible, controllable
 * `AttributedRange[]` output shaped exactly like the contract, not a correct
 * piece-table.
 *
 * Simplifications flagged for the final report:
 * - No real piece-table: ranges are a flat, contiguous, sorted array with a
 *   straightforward splice-and-reslice on every edit. Fine for UI/status-bar
 *   development; would not survive Agent D's ordering/undo fixtures, which
 *   is exactly why Agent A owns the real one.
 * - `ingestWholeFileDiff` does not line-diff at all -- it re-classifies the
 *   *entire* file as one span whenever content differs from the resolved
 *   baseline. Good enough to exercise the workspace-view's per-file rollup;
 *   not a stand-in for Agent A's real line-hunk-level classification.
 * - Classification is a single injectable `classify` function rather than
 *   the real tier ladder (hook-log/corroboration-store lookups) -- callers
 *   that want to demo/test the "external" bucket flip a per-workspace
 *   corroboration flag via `setCorroborationActive`, deliberately mirroring
 *   the real engine's `CorroborationStore`/`setGitOpSuppression` shape so
 *   swapping to the real engine later doesn't change how `extension.ts`
 *   drives it.
 */
import type {
  AttributedRange,
  ChangeReason,
  Disposable,
  EngineLike,
  NormalizedChange,
  NormalizedChangeBatch,
  Origin,
  Tier,
  WholeFileDiffInput,
} from "../contracts.ts";

const MAX_HISTORY_PER_DOC = 50;

interface DocState {
  content: string;
  ranges: AttributedRange[];
  history: Map<string, AttributedRange[]>;
}

export interface ClassifyInput {
  dirtyBefore: boolean;
  dirtyAfter: boolean;
  reason: ChangeReason;
  corroborationActive: boolean;
  suppressed: boolean;
}

export interface Classification {
  origin: Origin;
  tier: Tier | null;
}

/**
 * Default heuristic, deliberately mirroring the real engine's documented
 * live-path rule (src/core/engine.ts / tourist-raw's tracker.ts):
 * clean-before-and-after can only be a disk write, since typing always
 * dirties the document first. Corroborated -> "ai"; uncorroborated -> the
 * Tier-3 "external/unknown" bucket that is this project's whole point.
 */
export function defaultClassify(input: ClassifyInput): Classification {
  if (input.suppressed) return { origin: null, tier: null };
  const wouldBeDiskWrite = !input.dirtyBefore && !input.dirtyAfter;
  if (!wouldBeDiskWrite) return { origin: "human", tier: null };
  return input.corroborationActive ? { origin: "ai", tier: "2a" } : { origin: "external", tier: "3" };
}

export interface MockEngineOptions {
  classify?: (input: ClassifyInput) => Classification;
}

export class MockAttributionEngine implements EngineLike {
  private readonly docs = new Map<string, DocState>();
  private readonly corroboratedWorkspaces = new Set<string>();
  private readonly suppressedWorkspaces = new Set<string>();
  private readonly listeners = new Set<(docId: string) => void>();
  private readonly classify: (input: ClassifyInput) => Classification;
  /** Defaults to the identity function -- real wiring supplies a resolver
   * once workspace identity is settled, mirroring EngineDeps.resolveWorkspaceId. */
  resolveWorkspaceId: (docId: string) => string = (docId) => docId;

  constructor(options: MockEngineOptions = {}) {
    this.classify = options.classify ?? defaultClassify;
  }

  // -- Test/demo-only controls, not part of EngineLike ---------------------

  setCorroborationActive(workspaceId: string, active: boolean): void {
    if (active) this.corroboratedWorkspaces.add(workspaceId);
    else this.corroboratedWorkspaces.delete(workspaceId);
  }

  /** Directly seeds a document's ranges for fixture-driven tests, bypassing pushChanges. */
  seedRanges(docId: string, content: string, ranges: AttributedRange[]): void {
    this.docs.set(docId, { content, ranges: ranges.slice(), history: new Map() });
  }

  // -- EngineLike ------------------------------------------------------------

  open(docId: string, initialContent: string, restore?: AttributedRange[]): AttributedRange[] {
    if (this.docs.has(docId)) return this.docs.get(docId)!.ranges;
    const ranges =
      restore && spanLength(restore) === initialContent.length
        ? restore.slice()
        : initialContent.length > 0
          ? [{ startOffset: 0, endOffset: initialContent.length, origin: null, tier: null, timestamp: Date.now() }]
          : [];
    const state: DocState = { content: initialContent, ranges, history: new Map() };
    this.docs.set(docId, state);
    remember(state, hashContent(initialContent));
    return state.ranges;
  }

  close(docId: string): void {
    this.docs.delete(docId);
  }

  save(_docId: string): void {
    // Matches the real engine: no-op. Clean/dirty transitions are derived
    // entirely from dirtyBefore/dirtyAfter on the next change batch.
  }

  pushChanges(batch: NormalizedChangeBatch): AttributedRange[] {
    const state = this.ensureDoc(batch.docId);
    const timestamp = batch.timestamp ?? Date.now();

    if (batch.reason === "undo" || batch.reason === "redo") {
      applyRawEdits(state, batch.changes, null, null, timestamp);
      const hash = hashContent(state.content);
      const remembered = state.history.get(hash);
      if (remembered && spanLength(remembered) === state.content.length) {
        state.ranges = remembered.slice();
      }
      remember(state, hash);
      this.notify(batch.docId);
      return state.ranges;
    }

    const workspaceId = this.resolveWorkspaceId(batch.docId);
    const { origin, tier } = this.classify({
      dirtyBefore: batch.dirtyBefore,
      dirtyAfter: batch.dirtyAfter,
      reason: batch.reason,
      corroborationActive: this.corroboratedWorkspaces.has(workspaceId),
      suppressed: this.suppressedWorkspaces.has(workspaceId),
    });

    applyRawEdits(state, batch.changes, origin, tier, timestamp);
    remember(state, hashContent(state.content));
    this.notify(batch.docId);
    return state.ranges;
  }

  getRanges(docId: string): AttributedRange[] {
    return this.docs.get(docId)?.ranges ?? [];
  }

  onDidChangeRanges(listener: (docId: string) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  ingestWholeFileDiff(input: WholeFileDiffInput): AttributedRange[] {
    const existing = this.docs.get(input.docId);
    const previousContent = input.previousContent ?? existing?.content ?? "";
    if (previousContent === input.newContent) return existing?.ranges ?? [];

    const workspaceId = this.resolveWorkspaceId(input.docId);
    const suppressed = this.suppressedWorkspaces.has(workspaceId);
    const { origin, tier } = this.classify({
      dirtyBefore: false,
      dirtyAfter: false,
      reason: "typed",
      corroborationActive: this.corroboratedWorkspaces.has(workspaceId),
      suppressed,
    });

    const ranges: AttributedRange[] =
      suppressed || input.newContent.length === 0
        ? []
        : [{ startOffset: 0, endOffset: input.newContent.length, origin, tier, timestamp: input.timestamp }];

    const state: DocState = { content: input.newContent, ranges, history: existing?.history ?? new Map() };
    this.docs.set(input.docId, state);
    remember(state, hashContent(input.newContent));
    this.notify(input.docId);
    return state.ranges;
  }

  setGitOpSuppression(workspaceId: string, suppressed: boolean): void {
    if (suppressed) this.suppressedWorkspaces.add(workspaceId);
    else this.suppressedWorkspaces.delete(workspaceId);
  }

  listTrackedDocIds(): string[] {
    return [...this.docs.keys()];
  }

  // -- internals -------------------------------------------------------------

  private ensureDoc(docId: string): DocState {
    let state = this.docs.get(docId);
    if (!state) {
      state = { content: "", ranges: [], history: new Map() };
      this.docs.set(docId, state);
    }
    return state;
  }

  private notify(docId: string): void {
    for (const listener of this.listeners) listener(docId);
  }
}

function spanLength(ranges: readonly AttributedRange[]): number {
  return ranges.length ? ranges[ranges.length - 1].endOffset : 0;
}

function remember(state: DocState, hash: string): void {
  state.history.delete(hash);
  state.history.set(hash, state.ranges.slice());
  while (state.history.size > MAX_HISTORY_PER_DOC) {
    const oldest = state.history.keys().next().value;
    if (oldest === undefined) break;
    state.history.delete(oldest);
  }
}

/** Applies a batch of changes to both the content mirror and the ranges
 * array, right-to-left, so offsets computed from the original (pre-batch)
 * content stay valid for every change in the same batch regardless of the
 * array's original order -- the same ordering defense Agent A's real
 * piece-table applies (see PLAN1.md Phase 4's contentChanges-ordering row). */
function applyRawEdits(
  state: DocState,
  changes: readonly NormalizedChange[],
  origin: Origin,
  tier: Tier | null,
  timestamp: number
): void {
  const sorted = [...changes].sort((a, b) => b.rangeOffset - a.rangeOffset);
  for (const change of sorted) {
    state.content =
      state.content.slice(0, change.rangeOffset) + change.text + state.content.slice(change.rangeOffset + change.rangeLength);
    state.ranges = applyEditToRanges(state.ranges, change.rangeOffset, change.rangeLength, change.text.length, origin, tier, timestamp);
  }
}

function applyEditToRanges(
  ranges: readonly AttributedRange[],
  offset: number,
  length: number,
  newLength: number,
  origin: Origin,
  tier: Tier | null,
  timestamp: number
): AttributedRange[] {
  const end = offset + length;
  const delta = newLength - length;
  const result: AttributedRange[] = [];

  for (const r of ranges) {
    if (r.endOffset <= offset) {
      result.push(r);
    } else if (r.startOffset >= end) {
      result.push({ ...r, startOffset: r.startOffset + delta, endOffset: r.endOffset + delta });
    } else {
      if (r.startOffset < offset) result.push({ ...r, endOffset: offset });
      if (r.endOffset > end) result.push({ ...r, startOffset: end + delta, endOffset: r.endOffset + delta });
    }
  }

  if (newLength > 0) {
    result.push({ startOffset: offset, endOffset: offset + newLength, origin, tier, timestamp });
  }

  result.sort((a, b) => a.startOffset - b.startOffset);
  return mergeAdjacent(result);
}

function mergeAdjacent(ranges: readonly AttributedRange[]): AttributedRange[] {
  const out: AttributedRange[] = [];
  for (const r of ranges) {
    const last = out[out.length - 1];
    if (last && last.endOffset === r.startOffset && last.origin === r.origin && last.tier === r.tier) {
      last.endOffset = r.endOffset;
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

/** Simple deterministic, dependency-free string hash (FNV-1a) -- the mock
 * doesn't need cryptographic strength, just stable equality for the
 * undo/redo history map. */
function hashContent(content: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}
