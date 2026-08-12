import { execFile } from "node:child_process";
import type { GitRunner, GitRunResult } from "./types.js";

export class GitCommandError extends Error {
  constructor(public readonly args: string[], public readonly code: number, public readonly stderr: string) {
    super(`git ${args.join(" ")} exited ${code}: ${stderr.trim()}`);
  }
}

/** Real git execution — no shell, args passed as an array. */
export const defaultGitRunner: GitRunner = (repoRoot, args) =>
  new Promise<GitRunResult>((resolvePromise, reject) => {
    execFile("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && typeof (err as NodeJS.ErrnoException).code !== "number") {
        // Non-git-exit-code failure (e.g. git binary missing).
        reject(err);
        return;
      }
      const code = (err as { code?: number } | null)?.code ?? 0;
      resolvePromise({ stdout, code, ...(code !== 0 ? { stderr } : {}) } as GitRunResult & { stderr?: string });
    });
  });

/** Runs `runner`, raising GitCommandError on a non-zero exit rather than returning a code the caller must remember to check. */
export async function runGitOrThrow(runner: GitRunner, repoRoot: string, args: string[]): Promise<string> {
  const result = await runner(repoRoot, args);
  if (result.code !== 0) {
    throw new GitCommandError(args, result.code, (result as GitRunResult & { stderr?: string }).stderr ?? "");
  }
  return result.stdout;
}
