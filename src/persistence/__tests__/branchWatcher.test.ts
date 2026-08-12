import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BranchWatcher, type BranchChange } from "../branchWatcher.js";
import type { VscodeGitAPI, VscodeGitRepository } from "../vscodeGitTypes.js";

function git(cwd: string, args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Tourist Test", "-c", "user.email=tourist-test@example.com", ...args],
    { cwd, encoding: "utf8" }
  ).trim();
}

function makeFakeRepo(rootFsPath: string, initialBranch: string) {
  let head: { name?: string; commit?: string } = { name: initialBranch, commit: "sha-0" };
  const listeners: Array<() => void> = [];
  const repo: VscodeGitRepository = {
    rootUri: { fsPath: rootFsPath },
    state: {
      get HEAD() {
        return head;
      },
      onDidChange: (listener: () => void) => {
        listeners.push(listener);
        return { dispose: () => {} };
      }
    }
  };
  return {
    repo,
    checkout(branch: string) {
      head = { name: branch, commit: `sha-${branch}` };
      for (const l of listeners) l();
    }
  };
}

describe("BranchWatcher.watchVscodeGitApi", () => {
  it("does not fire on attach (only seeds initial state)", () => {
    const { repo } = makeFakeRepo("/fake/repo", "main");
    const api: VscodeGitAPI = { repositories: [repo], onDidOpenRepository: () => ({ dispose: () => {} }), getRepository: () => null };
    const onChange = vi.fn();
    const watcher = new BranchWatcher(10);
    watcher.watchVscodeGitApi(api, onChange);
    expect(onChange).not.toHaveBeenCalled();
    watcher.dispose();
  });

  it("fires exactly once per real branch change, debounced across bursts", async () => {
    const { repo, checkout } = makeFakeRepo("/fake/repo", "main");
    const api: VscodeGitAPI = { repositories: [repo], onDidOpenRepository: () => ({ dispose: () => {} }), getRepository: () => null };
    const onChange = vi.fn<(c: BranchChange) => void>();
    const watcher = new BranchWatcher(20);
    watcher.watchVscodeGitApi(api, onChange);

    // Simulate onDidChange firing multiple times during one checkout (index update, HEAD update, decorations...).
    checkout("feature/x");
    checkout("feature/x");
    checkout("feature/x");

    await new Promise((r) => setTimeout(r, 60));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toEqual({ repoRoot: "/fake/repo", branch: "feature/x", previousBranch: "main" });
    watcher.dispose();
  });

  it("attaches to repos opened after the watcher starts", () => {
    let openedListener: ((repo: VscodeGitRepository) => void) | undefined;
    const api: VscodeGitAPI = {
      repositories: [],
      onDidOpenRepository: (listener) => {
        openedListener = listener;
        return { dispose: () => {} };
      },
      getRepository: () => null
    };
    const onChange = vi.fn();
    const watcher = new BranchWatcher(10);
    watcher.watchVscodeGitApi(api, onChange);

    const { repo } = makeFakeRepo("/fake/late-repo", "main");
    openedListener!(repo);
    expect(onChange).not.toHaveBeenCalled(); // still just seeding
    watcher.dispose();
  });
});

describe("BranchWatcher.watchFallback (real git repo)", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "tourist-branchwatch-"));
    git(repoDir, ["init", "-q", "-b", "main"]);
    await writeFile(join(repoDir, "a.txt"), "hello\n");
    git(repoDir, ["add", "a.txt"]);
    git(repoDir, ["commit", "-q", "-m", "initial"]);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("detects a real `git checkout -b` via the HEAD file watcher", async () => {
    const onChange = vi.fn<(c: BranchChange) => void>();
    const watcher = new BranchWatcher(20);
    await watcher.watchFallback(repoDir, onChange);

    git(repoDir, ["checkout", "-q", "-b", "feature/y"]);

    await new Promise((r) => setTimeout(r, 300));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ repoRoot: repoDir, branch: "feature/y", previousBranch: "main" })
    );
    watcher.dispose();
  });
});
