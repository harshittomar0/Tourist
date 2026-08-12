import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LockFileWatcherAdapter } from "../core/adapter-interfaces.ts";
import type { CorroborationSignal } from "../core/corroboration-store.ts";
import type { Disposable } from "../core/types.ts";

/** Shape confirmed via claudecode.nvim's independent PROTOCOL.md reverse-
 * engineering (RESEARCH1.md §2 Approach C) -- not from an official .d.ts,
 * since the lock file is an internal implementation detail of the `ide` MCP
 * server, not a published API. */
interface LockFileContents {
  pid?: number;
  workspaceFolders?: string[];
  ideName?: string;
  transport?: string;
  authToken?: string;
}

function lockDir(): string {
  const override = process.env.CLAUDE_CONFIG_DIR;
  return override ? path.join(override, "ide") : path.join(os.homedir(), ".claude", "ide");
}

function readLockFile(absPath: string): LockFileContents | null {
  try {
    return JSON.parse(fs.readFileSync(absPath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Whether a workspace root is "contained by" one of a lock file's reported
 * `workspaceFolders`. Deliberately strict containment (per RESEARCH1.md §5's
 * "err toward stricter matching even if it costs recall" fallback for the
 * as-yet-unverified monorepo/`--add-dir`/nested-folder matching precision
 * risk) rather than a loose substring match.
 */
function matchesWorkspace(workspaceRoot: string, workspaceFolders: string[] | undefined): boolean {
  if (!workspaceFolders) return false;
  const normalizedRoot = path.resolve(workspaceRoot);
  return workspaceFolders.some((folder) => {
    const normalizedFolder = path.resolve(folder);
    return normalizedRoot === normalizedFolder || normalizedRoot.startsWith(normalizedFolder + path.sep);
  });
}

/**
 * TODO(Phase 0 experiment 2): this currently corroborates on lock-file
 * *existence* alone, matched to a workspace by `workspaceFolders`
 * containment. Experiment 2 determines whether a stale lock left behind by
 * a `SIGKILL`'d Claude Code session survives long enough to falsely
 * over-corroborate Tier 2a after the session is actually gone, and if so,
 * whether a `pid`-liveness check (`process.kill(pid, 0)`, which throws
 * ESRCH if the pid is dead, on the same machine) needs to be layered on top.
 * `checkPidLiveness` below implements that check and is wired in but
 * defaults to *off* (`pidLivenessCheck: false`) until experiment 2 confirms
 * it's actually needed -- flipping it on is a one-line change once it is.
 */
export interface LockFileWatcherOptions {
  pidLivenessCheck?: boolean;
  /** Poll interval as a defensive fallback in case fs.watch misses an event
   * (documented as possible on some platforms/network filesystems). Real
   * responsiveness comes from fs.watch; this just bounds worst-case latency. */
  pollIntervalMs?: number;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class NodeLockFileWatcherAdapter implements LockFileWatcherAdapter {
  private watcher: fs.FSWatcher | null = null;
  private pollHandle: NodeJS.Timeout | null = null;
  private workspaceRoots: string[] = [];
  private readonly listeners = new Set<(workspaceRoot: string, signal: CorroborationSignal) => void>();
  private readonly activeSince = new Map<string, number>();

  constructor(private readonly options: LockFileWatcherOptions = {}) {}

  start(workspaceRoots: string[]): void {
    this.workspaceRoots = workspaceRoots;
    const dir = lockDir();
    try {
      fs.mkdirSync(dir, { recursive: true });
      this.watcher = fs.watch(dir, () => this.rescan());
    } catch {
      // Directory doesn't exist / not readable -- fall back to polling only.
    }
    this.pollHandle = setInterval(() => this.rescan(), this.options.pollIntervalMs ?? 5000);
    this.rescan();
  }

  dispose(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.pollHandle) clearInterval(this.pollHandle);
    this.pollHandle = null;
  }

  onDidChangeSignal(listener: (workspaceRoot: string, signal: CorroborationSignal) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private rescan(): void {
    const dir = lockDir();
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir).filter((f) => f.endsWith(".lock"));
    } catch {
      entries = [];
    }

    const matchedRoots = new Set<string>();
    for (const entry of entries) {
      const contents = readLockFile(path.join(dir, entry));
      if (!contents) continue;
      if (this.options.pidLivenessCheck && contents.pid !== undefined && !isPidAlive(contents.pid)) continue;
      for (const root of this.workspaceRoots) {
        if (matchesWorkspace(root, contents.workspaceFolders)) matchedRoots.add(root);
      }
    }

    for (const root of this.workspaceRoots) {
      const isActive = matchedRoots.has(root);
      const wasActive = this.activeSince.has(root);
      if (isActive === wasActive) continue;

      if (isActive) {
        const since = Date.now();
        this.activeSince.set(root, since);
        this.emit(root, { source: "lock-file", active: true, since });
      } else {
        this.activeSince.delete(root);
        this.emit(root, { source: "lock-file", active: false, since: Date.now() });
      }
    }
  }

  private emit(workspaceRoot: string, signal: CorroborationSignal): void {
    for (const listener of this.listeners) listener(workspaceRoot, signal);
  }
}
