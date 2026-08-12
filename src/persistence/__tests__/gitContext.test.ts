import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findRepoRootFallback, resolveBranchFallback, resolveGitContext, resolveGitContextFallback } from "../gitContext.js";
import type { VscodeGitAPI } from "../vscodeGitTypes.js";

function git(cwd: string, args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Tourist Test", "-c", "user.email=tourist-test@example.com", ...args],
    { cwd, encoding: "utf8" }
  ).trim();
}

async function initRepo(dir: string): Promise<void> {
  git(dir, ["init", "-q", "-b", "main"]);
  await writeFile(join(dir, "a.txt"), "hello\n");
  git(dir, ["add", "a.txt"]);
  git(dir, ["commit", "-q", "-m", "initial"]);
}

describe("findRepoRootFallback / resolveBranchFallback (real git repos)", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "tourist-git-"));
    await initRepo(repoDir);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("finds the repo root from a nested file path", async () => {
    const root = await findRepoRootFallback(join(repoDir, "a.txt"));
    expect(root).toBe(repoDir);
  });

  it("resolves the current branch name", async () => {
    const branch = await resolveBranchFallback(repoDir);
    expect(branch).toBe("main");
  });

  it("resolves a feature branch after checkout", async () => {
    git(repoDir, ["checkout", "-q", "-b", "feature/x"]);
    const branch = await resolveBranchFallback(repoDir);
    expect(branch).toBe("feature/x");
  });

  it("keys detached HEAD by commit sha", async () => {
    const sha = git(repoDir, ["rev-parse", "HEAD"]);
    git(repoDir, ["checkout", "-q", sha]);
    const branch = await resolveBranchFallback(repoDir);
    expect(branch.startsWith("detached-")).toBe(true);
    expect(branch).toContain(sha.slice(0, 12));
  });

  it("resolveGitContextFallback returns both repoRoot and branch", async () => {
    const ctx = await resolveGitContextFallback(join(repoDir, "a.txt"));
    expect(ctx).toEqual({ repoRoot: repoDir, branch: "main" });
  });
});

describe("worktree gitdir: pointer handling", () => {
  let mainRepoDir: string;
  let worktreeDir: string;
  let parentDir: string;

  beforeEach(async () => {
    parentDir = await mkdtemp(join(tmpdir(), "tourist-wt-parent-"));
    mainRepoDir = join(parentDir, "main-repo");
    await mkdir(mainRepoDir);
    await initRepo(mainRepoDir);
    worktreeDir = join(parentDir, "wt-feature");
    git(mainRepoDir, ["worktree", "add", "-q", "-b", "feature/worktree-branch", worktreeDir]);
  });

  afterEach(async () => {
    await rm(parentDir, { recursive: true, force: true });
  });

  it("resolves the worktree's own branch, not the main repo's", async () => {
    const branch = await resolveBranchFallback(worktreeDir);
    expect(branch).toBe("feature/worktree-branch");

    const mainBranch = await resolveBranchFallback(mainRepoDir);
    expect(mainBranch).toBe("main");
  });

  it("treats the worktree directory itself as the repo root (not the main repo's)", async () => {
    const root = await findRepoRootFallback(join(worktreeDir, "a.txt"));
    expect(root).toBe(worktreeDir);
  });
});

describe("resolveGitContext with an injected vscode.git API", () => {
  it("prefers the API's HEAD.name over the filesystem", async () => {
    const fakeApi: VscodeGitAPI = {
      repositories: [
        {
          rootUri: { fsPath: "/fake/repo" },
          state: { HEAD: { name: "from-api-branch" }, onDidChange: () => ({ dispose() {} }) }
        }
      ],
      onDidOpenRepository: () => ({ dispose() {} }),
      getRepository: (uri) => (uri.fsPath.startsWith("/fake/repo") ? fakeApi.repositories[0] : null)
    };

    const ctx = await resolveGitContext("/fake/repo/src/file.ts", fakeApi);
    expect(ctx).toEqual({ repoRoot: "/fake/repo", branch: "from-api-branch" });
  });

  it("falls back to the filesystem when the API reports detached HEAD", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "tourist-git-detached-"));
    try {
      await initRepo(repoDir);
      const fakeApi: VscodeGitAPI = {
        repositories: [
          { rootUri: { fsPath: repoDir }, state: { HEAD: { name: undefined, commit: "deadbeef" }, onDidChange: () => ({ dispose() {} }) } }
        ],
        onDidOpenRepository: () => ({ dispose() {} }),
        getRepository: (uri) => (uri.fsPath === repoDir ? fakeApi.repositories[0] : null)
      };

      const ctx = await resolveGitContext(join(repoDir, "a.txt"), fakeApi);
      expect(ctx?.repoRoot).toBe(repoDir);
      expect(ctx?.branch).toBe("main");
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });
});
