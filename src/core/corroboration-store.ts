import type { Disposable } from "./types.ts";

export type CorroborationSource = "lock-file" | "shell-integration" | "process-scan";

/**
 * Contract §3 -- one signal record written by a Tier 2a/2b/2c adapter into
 * the shared store, per workspace identity.
 */
export interface CorroborationSignal {
  source: CorroborationSource;
  active: boolean;
  since: number;
  metadata?: Record<string, unknown>;
}

export interface CorroborationEntry {
  active: boolean;
  since?: number;
  metadata?: Record<string, unknown>;
}

export interface CorroborationSnapshot {
  lockFile: CorroborationEntry;
  shellIntegration: CorroborationEntry;
  processScan: CorroborationEntry;
}

const SOURCE_TO_SNAPSHOT_KEY: Record<CorroborationSource, keyof CorroborationSnapshot> = {
  "lock-file": "lockFile",
  "shell-integration": "shellIntegration",
  "process-scan": "processScan",
};

/**
 * "Is Claude Code active here" as one reusable fact (RESEARCH1.md §7's
 * explicit recommendation), written to by whichever Tier 2a/2b/2c adapters
 * are enabled (src/adapters/) and read by src/core/tier-classifier.ts --
 * instead of three scattered ad hoc checks.
 */
export class CorroborationStore {
  private state = new Map<string, Partial<Record<CorroborationSource, CorroborationSignal>>>();
  private listeners = new Set<(workspaceId: string) => void>();

  setSignal(workspaceId: string, signal: CorroborationSignal): void {
    const bySource = this.state.get(workspaceId) ?? {};
    bySource[signal.source] = signal;
    this.state.set(workspaceId, bySource);
    for (const listener of this.listeners) listener(workspaceId);
  }

  clearSignal(workspaceId: string, source: CorroborationSource): void {
    const bySource = this.state.get(workspaceId);
    if (!bySource || !(source in bySource)) return;
    delete bySource[source];
    for (const listener of this.listeners) listener(workspaceId);
  }

  getSnapshot(workspaceId: string): CorroborationSnapshot {
    const bySource = this.state.get(workspaceId) ?? {};
    const toEntry = (source: CorroborationSource): CorroborationEntry => {
      const signal = bySource[source];
      return signal ? { active: signal.active, since: signal.since, metadata: signal.metadata } : { active: false };
    };
    return {
      lockFile: toEntry("lock-file"),
      shellIntegration: toEntry("shell-integration"),
      processScan: toEntry("process-scan"),
    };
  }

  onDidChange(listener: (workspaceId: string) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
}

export function snapshotKeyFor(source: CorroborationSource): keyof CorroborationSnapshot {
  return SOURCE_TO_SNAPSHOT_KEY[source];
}
