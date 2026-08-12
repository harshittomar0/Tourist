import * as path from "node:path";
import type { ProcessScanFallbackAdapter } from "../core/adapter-interfaces.ts";
import type { CorroborationSignal } from "../core/corroboration-store.ts";
import type { Disposable } from "../core/types.ts";

/**
 * Tier 2c corroboration (fallback-of-a-fallback, per RESEARCH1.md §2
 * Approach A / §7): polls the OS process list for a `claude` process whose
 * `cwd`/`cmd` matches a tracked workspace root. Only consulted by the tier
 * ladder when 2a and 2b both come back inactive.
 *
 * TODO(Phase 0 experiment 9, lowest priority per PLAN1.md's own ordering):
 * whether `ps-list` can actually correlate a running `claude` process to a
 * specific workspace path via `cwd`/`cmd` is unverified -- this adapter is
 * wired and best-effort-functional (matches on `cwd` when the library
 * reports it, falls back to a `cmd` substring match otherwise), but
 * RESEARCH1.md §2 Approach A explicitly flags this as fragile even on
 * macOS/Linux (launching from a parent dir, a monorepo subfolder, or
 * `--worktree`/`--add-dir` all break naive cwd matching) and *unusable* on
 * Windows (`cmd`/`cwd` aren't available there per `ps-list`'s own docs --
 * this adapter degrades to "never corroborates" on Windows by construction,
 * which is the documented, accepted v1 gap per GOAL1.md §2, not a bug).
 * Experiment 9 decides whether Tier 2c is worth shipping in v1 at all; if
 * not, the fix is to simply never call `start()` on this adapter from
 * extension.ts, not to change this file.
 */
export interface ProcessScanFallbackOptions {
  pollIntervalMs?: number;
  /** Injectable for unit testing without touching the real OS process list. */
  listProcesses?: () => Promise<Array<{ pid: number; cmd?: string; cwd?: string }>>;
}

async function defaultListProcesses(): Promise<Array<{ pid: number; cmd?: string; cwd?: string }>> {
  // Imported lazily (rather than at module load) so environments that never
  // enable Tier 2c don't pay for loading `ps-list` at all.
  const psList = (await import("ps-list")).default;
  return psList();
}

function matchesWorkspace(root: string, proc: { cmd?: string; cwd?: string }): boolean {
  const normalizedRoot = path.resolve(root);
  if (proc.cwd) {
    const normalizedCwd = path.resolve(proc.cwd);
    if (normalizedCwd === normalizedRoot || normalizedCwd.startsWith(normalizedRoot + path.sep)) return true;
  }
  // Weaker fallback: cwd unavailable (e.g. Windows, or a sandboxed process) --
  // string-match the workspace root into the reported command line. Fragile
  // by design (see the TODO above); never used to *increase* confidence
  // beyond Tier 2c.
  return !!proc.cmd?.includes(normalizedRoot);
}

function looksLikeClaude(cmd: string | undefined): boolean {
  if (!cmd) return false;
  return /(^|[\\/])claude(\s|$)/.test(cmd);
}

export class PsListProcessScanFallbackAdapter implements ProcessScanFallbackAdapter {
  private pollHandle: NodeJS.Timeout | null = null;
  private workspaceRoots: string[] = [];
  private readonly listeners = new Set<(workspaceRoot: string, signal: CorroborationSignal) => void>();
  private readonly activeSince = new Map<string, number>();

  constructor(private readonly options: ProcessScanFallbackOptions = {}) {}

  start(workspaceRoots: string[]): void {
    this.workspaceRoots = workspaceRoots;
    this.pollHandle = setInterval(() => void this.poll(), this.options.pollIntervalMs ?? 5000);
    void this.poll();
  }

  dispose(): void {
    if (this.pollHandle) clearInterval(this.pollHandle);
    this.pollHandle = null;
  }

  onDidChangeSignal(listener: (workspaceRoot: string, signal: CorroborationSignal) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private async poll(): Promise<void> {
    let processes: Array<{ pid: number; cmd?: string; cwd?: string }>;
    try {
      processes = await (this.options.listProcesses ?? defaultListProcesses)();
    } catch {
      return; // ps-list unavailable/unsupported on this platform -- never corroborate.
    }

    const claudeProcs = processes.filter((p) => looksLikeClaude(p.cmd));
    const matchedRoots = new Set<string>();
    for (const root of this.workspaceRoots) {
      if (claudeProcs.some((p) => matchesWorkspace(root, p))) matchedRoots.add(root);
    }

    for (const root of this.workspaceRoots) {
      const isActive = matchedRoots.has(root);
      const wasActive = this.activeSince.has(root);
      if (isActive === wasActive) continue;
      if (isActive) {
        const since = Date.now();
        this.activeSince.set(root, since);
        this.emit(root, { source: "process-scan", active: true, since });
      } else {
        this.activeSince.delete(root);
        this.emit(root, { source: "process-scan", active: false, since: Date.now() });
      }
    }
  }

  private emit(workspaceRoot: string, signal: CorroborationSignal): void {
    for (const listener of this.listeners) listener(workspaceRoot, signal);
  }
}
