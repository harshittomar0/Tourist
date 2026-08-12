import type { Disposable } from "./types.ts";
import type { CorroborationSignal } from "./corroboration-store.ts";

/**
 * Interfaces the four platform adapters (src/adapters/) implement. Defined
 * here in src/core/ per the module ownership map ("each adapter is a thin
 * implementation of an interface Agent A defines in src/core/"), so the
 * adapter's own OS-level I/O code can live in a separate directory Agent C
 * never needs to touch, while tier semantics and their signal sources stay
 * co-owned by Agent A.
 */

// ---------------------------------------------------------------------------
// Tier 2a -- lock-file watcher
// ---------------------------------------------------------------------------

export interface LockFileWatcherAdapter extends Disposable {
  /** Begin watching `~/.claude/ide/*.lock` (or `$CLAUDE_CONFIG_DIR/ide/`)
   * for lock files whose `workspaceFolders` match any of `workspaceRoots`. */
  start(workspaceRoots: string[]): void;
  onDidChangeSignal(listener: (workspaceRoot: string, signal: CorroborationSignal) => void): Disposable;
}

// ---------------------------------------------------------------------------
// Tier 2b -- terminal shell-integration bridge
// ---------------------------------------------------------------------------

export interface ShellIntegrationBridgeAdapter extends Disposable {
  start(workspaceRoots: string[]): void;
  onDidChangeSignal(listener: (workspaceRoot: string, signal: CorroborationSignal) => void): Disposable;
}

// ---------------------------------------------------------------------------
// Tier 2c -- process-scan fallback
// ---------------------------------------------------------------------------

export interface ProcessScanFallbackAdapter extends Disposable {
  start(workspaceRoots: string[]): void;
  onDidChangeSignal(listener: (workspaceRoot: string, signal: CorroborationSignal) => void): Disposable;
}

// ---------------------------------------------------------------------------
// Tier 1 -- hook-log reader/installer (ground truth)
// ---------------------------------------------------------------------------

export interface HookLogReaderAdapter extends Disposable {
  /** Registers PreToolUse/PostToolUse hooks in `~/.claude/settings.json`
   * (idempotent -- safe to call when already installed). */
  install(): Promise<{ alreadyInstalled: boolean }>;
  isInstalled(): Promise<boolean>;

  /**
   * Whole-content Tier-1 check for the live-editing path: true if some hook
   * record for `absolutePath` has this exact post-edit `contentHash`. A
   * whole-file hash match is sufficient here because the live path
   * classifies one whole document-change event at a time (matching
   * tourist-raw's own per-event, not per-line, classification granularity)
   * -- it does not need per-line hook precision the way the whole-file-diff
   * path does.
   */
  matchesContent(absolutePath: string, contentHash: string): boolean;

  /**
   * Per-span Tier-1 check for the whole-file-diff path: true if a hook
   * record for `absolutePath` with this `contentHash` marks
   * [lineStart, lineEnd) (0-based, half-open, in the *new* content) as
   * AI-authored. More precise than corroboration alone, since the hook's
   * own PreToolUse/PostToolUse diff already knows exactly which lines it
   * wrote -- see hooks/attribution-hook.mjs.
   */
  matchesSpan(absolutePath: string, contentHash: string, lineStart: number, lineEnd: number): boolean;

  onDidAppendRecord(listener: () => void): Disposable;
}
