import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { RepoBranchKey } from "./types.js";
import type { VscodeGitAPI, VscodeGitRepository } from "./vscodeGitTypes.js";

export const DETACHED_HEAD_PREFIX = "detached-";

function branchFromHeadContents(headContents: string): string {
  const trimmed = headContents.trim();
  const match = trimmed.match(/^ref:\s*refs\/heads\/(.+)$/);
  if (match) return match[1];
  // Detached HEAD: file holds a raw commit SHA.
  return `${DETACHED_HEAD_PREFIX}${trimmed.slice(0, 12)}`;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Walks up from `startPath` looking for a `.git` entry (dir or file — worktrees use a file). */
export async function findRepoRootFallback(startPath: string): Promise<string | undefined> {
  let dir = resolve(startPath);
  const startStat = await stat(dir).catch(() => undefined);
  if (startStat && !startStat.isDirectory()) {
    dir = dirname(dir);
  }
  for (;;) {
    if (await pathExists(join(dir, ".git"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Resolves the worktree-private git dir for `repoRoot` — where HEAD, index,
 * and the sequencer state (CHERRY_PICK_HEAD, etc.) live. In a worktree,
 * `<root>/.git` is a *file* (not a directory) containing
 * `gitdir: <path to .git/worktrees/<name>>`; for the main working tree it's
 * just `<root>/.git` itself.
 */
export async function resolveGitDir(repoRoot: string): Promise<string> {
  const dotGitPath = join(repoRoot, ".git");
  const dotGitStat = await stat(dotGitPath);
  if (dotGitStat.isDirectory()) {
    return dotGitPath;
  }
  const contents = await readFile(dotGitPath, "utf8");
  const match = contents.match(/^gitdir:\s*(.+)$/m);
  if (!match) {
    throw new Error(`Malformed .git file at ${dotGitPath}: missing "gitdir:" pointer`);
  }
  const gitDirRaw = match[1].trim();
  return isAbsolute(gitDirRaw) ? gitDirRaw : resolve(repoRoot, gitDirRaw);
}

/**
 * Resolves the *common* git dir — shared across all worktrees — where hooks,
 * objects, and refs/notes/* live. For the main working tree this is the same
 * as `resolveGitDir`; for a worktree it's read from the private gitdir's
 * `commondir` pointer file.
 */
export async function resolveCommonGitDir(repoRoot: string): Promise<string> {
  const gitDir = await resolveGitDir(repoRoot);
  const commondirPath = join(gitDir, "commondir");
  if (!(await pathExists(commondirPath))) {
    return gitDir; // main working tree — its own gitdir IS the common dir
  }
  const commondirRaw = (await readFile(commondirPath, "utf8")).trim();
  return isAbsolute(commondirRaw) ? commondirRaw : resolve(gitDir, commondirRaw);
}

export async function resolveHeadFilePath(repoRoot: string): Promise<string> {
  const gitDir = await resolveGitDir(repoRoot);
  return join(gitDir, "HEAD");
}

export async function resolveBranchFallback(repoRoot: string): Promise<string> {
  const headFilePath = await resolveHeadFilePath(repoRoot);
  const headContents = await readFile(headFilePath, "utf8");
  return branchFromHeadContents(headContents);
}

/** Raw-filesystem fallback, used only when the vscode.git extension API is unavailable. */
export async function resolveGitContextFallback(fileFsPath: string): Promise<RepoBranchKey | undefined> {
  const repoRoot = await findRepoRootFallback(fileFsPath);
  if (!repoRoot) return undefined;
  const branch = await resolveBranchFallback(repoRoot);
  return { repoRoot, branch };
}

function repositoryForFile(api: VscodeGitAPI, fileFsPath: string): VscodeGitRepository | undefined {
  const direct = api.getRepository({ fsPath: fileFsPath });
  if (direct) return direct;
  // getRepository can be picky about exact-file vs containing-folder depending on host version;
  // fall back to a longest-prefix match over open repositories.
  let best: VscodeGitRepository | undefined;
  for (const repo of api.repositories) {
    if (fileFsPath.startsWith(repo.rootUri.fsPath) && (!best || repo.rootUri.fsPath.length > best.rootUri.fsPath.length)) {
      best = repo;
    }
  }
  return best;
}

/**
 * Primary resolution path: ask the vscode.git extension, which already tracks
 * repo/branch state without touching the filesystem ourselves. Falls back to
 * raw-fs parsing only when the API isn't available (no extension host, or the
 * file isn't inside any repo the API has opened yet).
 */
export async function resolveGitContext(
  fileFsPath: string,
  vscodeGitApi?: VscodeGitAPI
): Promise<RepoBranchKey | undefined> {
  if (vscodeGitApi) {
    const repo = repositoryForFile(vscodeGitApi, fileFsPath);
    const branchName = repo?.state.HEAD?.name;
    if (repo && branchName) {
      return { repoRoot: repo.rootUri.fsPath, branch: branchName };
    }
    if (repo && !branchName) {
      // Detached HEAD via the API: fall through to fs for a stable commit-based key.
      return resolveGitContextFallback(fileFsPath);
    }
  }
  return resolveGitContextFallback(fileFsPath);
}
