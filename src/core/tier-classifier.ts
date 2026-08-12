import type { CorroborationSnapshot } from "./corroboration-store.ts";
import type { Origin, Tier } from "./types.ts";

export interface Classification {
  origin: Origin;
  tier: Tier | null;
}

export interface LiveClassificationInput {
  dirtyBefore: boolean;
  dirtyAfter: boolean;
  /** True if a Tier-1 hook-log record matches this document-change event. */
  hookMatch: boolean;
  corroboration: CorroborationSnapshot;
  /** True during a git-op suppression window (see engine.ts
   * `setGitOpSuppression` -- an addition beyond the literal contract; see
   * final report). */
  suppressed: boolean;
}

export interface SpanClassificationInput {
  hookMatch: boolean;
  corroboration: CorroborationSnapshot;
  suppressed: boolean;
}

/**
 * Tier decision table per RESEARCH1.md §7 / PLAN1.md Phase 1:
 * 1 -> 2a -> 2b-augments-2a -> 2c-fallback -> 3 "external/unknown"
 * (Tier 4 deliberately not implemented -- see the bottom of this file).
 *
 * `spike/FINDINGS.md` did not exist yet at the time this was implemented
 * (Agent D produces it in parallel), so this is a best-effort table per
 * RESEARCH1.md §7's *hypothesized* tiers, not yet confirmed by Phase 0.
 * Specifically pending, cited by exact experiment number:
 *
 *  - Experiment 1 (diff-accept mechanics): if accepting a diff in the real
 *    VS Code extension transiently dirties a plain open tab on the same
 *    file, the live-edit ingestion path upstream of this function may need
 *    an explicit "diff-review-in-progress" state that suppresses
 *    misclassifying that dirtying as a human edit -- this function's own
 *    hook-first-then-dirty-check structure does not itself need to change,
 *    but the `dirtyBefore`/`dirtyAfter` inputs it receives might, depending
 *    on how Agent C's document-change listener ends up needing to filter
 *    diff-view documents.
 *  - Experiment 2 (lock-file lifecycle): whether `corroboration.lockFile`
 *    needs a pid-liveness check layered on top of file existence (see the
 *    TODO in src/adapters/lock-file-watcher.ts).
 *  - Experiment 3 (shell-integration precision): whether low/none-confidence
 *    `commandLine.confidence` values should be excluded from
 *    `corroboration.shellIntegration.active` in the first place (see the
 *    TODO in src/adapters/shell-integration-bridge.ts) -- this function
 *    trusts whatever the corroboration store says is active.
 */
export function classifyLiveChange(input: LiveClassificationInput): Classification {
  if (input.hookMatch) return { origin: "ai", tier: "1" };

  const wouldBeDiskWrite = !input.dirtyBefore && !input.dirtyAfter;
  if (!wouldBeDiskWrite) return { origin: "human", tier: null };

  return classifyDiskWrite(input.corroboration, input.suppressed);
}

/**
 * Same tier ladder, for the whole-file-diff ingestion path (tracked files
 * with no open document): there is no dirty-before/after signal to check at
 * all -- meaningless for a closed file, per PLAN1.md Phase 1 -- so this goes
 * straight from a Tier-1 hook-log span match to corroboration-state lookup.
 */
export function classifyWholeFileDiffSpan(input: SpanClassificationInput): Classification {
  if (input.hookMatch) return { origin: "ai", tier: "1" };
  return classifyDiskWrite(input.corroboration, input.suppressed);
}

function classifyDiskWrite(corroboration: CorroborationSnapshot, suppressed: boolean): Classification {
  // A git operation (checkout/pull/rebase/stash) rewrites a clean file on
  // disk the same way Claude Code does. The caller (engine.ts's
  // `setGitOpSuppression`) signals this window so the change lands
  // unmarked/reconciled instead of "ai" or "external" -- generalized from
  // tourist-raw/src/attribution/tracker.ts's `suppressAi` guard, which only
  // ever needed to null out an "ai" outcome (the old model had no
  // "external" bucket). Here suppression short-circuits the whole
  // disk-write branch, since a git-rewritten clean file is never
  // "external/unknown" either.
  if (suppressed) return { origin: null, tier: null };

  if (corroboration.lockFile.active && corroboration.shellIntegration.active) {
    return { origin: "ai", tier: "2b" };
  }
  if (corroboration.lockFile.active) {
    return { origin: "ai", tier: "2a" };
  }
  if (corroboration.shellIntegration.active) {
    return { origin: "ai", tier: "2b" };
  }
  if (corroboration.processScan.active) {
    return { origin: "ai", tier: "2c" };
  }
  return { origin: "external", tier: "3" };
}

// Tier 4 (stylometric fallback) is explicitly out of v1 scope per GOAL1.md
// §2 ("not built in v1... not worth v1 engineering budget"), and per
// RESEARCH1.md §7 must never outrank tiers 1-3 even if it existed. Not
// implemented here, not even as a disabled stub -- this is a scope
// decision recorded in GOAL1.md, not a Phase-0-pending TODO.
