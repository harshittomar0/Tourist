import { watch as fsWatch } from "node:fs";
import { basename, dirname } from "node:path";
import { resolveBranchFallback, resolveHeadFilePath } from "./gitContext.js";
import type { VscodeGitAPI, VscodeGitRepository } from "./vscodeGitTypes.js";

export interface BranchChange {
  repoRoot: string;
  branch: string;
  previousBranch: string | undefined;
}

export type BranchChangeListener = (change: BranchChange) => void;

const DEFAULT_DEBOUNCE_MS = 200;

function debounce(fn: () => void, ms: number): { run: () => void; dispose: () => void } {
  let timer: NodeJS.Timeout | undefined;
  return {
    run: () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(fn, ms);
    },
    dispose: () => {
      if (timer) clearTimeout(timer);
    }
  };
}

function currentKeyOf(repo: VscodeGitRepository): string | undefined {
  const head = repo.state.HEAD;
  if (!head) return undefined;
  if (head.name) return head.name;
  if (head.commit) return `detached-${head.commit.slice(0, 12)}`;
  return undefined;
}

/**
 * Diffs `state.HEAD` across the git extension's single generic `onDidChange`
 * signal (see SPIKE_NOTES.md — there is no dedicated branch-change event) and
 * only calls `onChange` when the resolved branch actually differs.
 */
export class BranchWatcher {
  private readonly lastByRoot = new Map<string, string>();
  private readonly disposers: Array<() => void> = [];

  constructor(private readonly debounceMs: number = DEFAULT_DEBOUNCE_MS) {}

  watchVscodeGitApi(api: VscodeGitAPI, onChange: BranchChangeListener): void {
    const attach = (repo: VscodeGitRepository) => {
      const react = () => {
        const key = currentKeyOf(repo);
        if (key === undefined) return;
        const repoRoot = repo.rootUri.fsPath;
        const previous = this.lastByRoot.get(repoRoot);
        if (previous === key) return;
        this.lastByRoot.set(repoRoot, key);
        if (previous !== undefined) {
          onChange({ repoRoot, branch: key, previousBranch: previous });
        }
      };
      react(); // seed initial state without firing a change
      const debounced = debounce(react, this.debounceMs);
      const sub = repo.state.onDidChange(debounced.run);
      this.disposers.push(() => {
        debounced.dispose();
        sub.dispose();
      });
    };

    for (const repo of api.repositories) attach(repo);
    const openSub = api.onDidOpenRepository(attach);
    this.disposers.push(() => openSub.dispose());
  }

  /**
   * Raw-fs fallback: watch for HEAD updates when the vscode.git API is
   * unavailable. Watches HEAD's *parent directory* rather than the file
   * itself — git updates refs (including HEAD) via a lock-file-then-rename,
   * which replaces the file's inode and can cause a direct file watch to
   * silently stop reporting changes on some platforms.
   */
  async watchFallback(repoRoot: string, onChange: BranchChangeListener): Promise<void> {
    const headFilePath = await resolveHeadFilePath(repoRoot);
    const headFileName = basename(headFilePath);
    const react = async () => {
      const branch = await resolveBranchFallback(repoRoot).catch(() => undefined);
      if (!branch) return;
      const previous = this.lastByRoot.get(repoRoot);
      if (previous === branch) return;
      this.lastByRoot.set(repoRoot, branch);
      if (previous !== undefined) {
        onChange({ repoRoot, branch, previousBranch: previous });
      }
    };
    this.lastByRoot.set(repoRoot, await resolveBranchFallback(repoRoot));
    const debounced = debounce(() => void react(), this.debounceMs);
    const watcher = fsWatch(dirname(headFilePath), (_eventType, filename) => {
      if (filename === null || filename === headFileName) debounced.run();
    });
    this.disposers.push(() => {
      debounced.dispose();
      watcher.close();
    });
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
  }
}
