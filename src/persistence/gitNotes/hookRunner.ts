#!/usr/bin/env node
/**
 * CLI entrypoint invoked by the hooks `installHook` writes. Reads the
 * attribution-sharing toggle straight from git config (a plain config read,
 * not git-notes I/O, so this is fine to do unconditionally) and dispatches to
 * the corresponding handler. Never exits non-zero for attribution bookkeeping
 * problems — a hook that can abort a commit over this would be a much bigger
 * footgun than a missed note.
 */
import { execFileSync } from "node:child_process";
import { defaultGitRunner } from "./gitPlumbing.js";
import { handlePostCommit, handlePostRewrite } from "./rewriteContinuity.js";
import type { AttributionSharingConfig } from "./config.js";

function readConfig(repoRoot: string): AttributionSharingConfig {
  try {
    const raw = execFileSync("git", ["config", "--bool", "tourist.attributionSharing.enabled"], {
      cwd: repoRoot,
      encoding: "utf8"
    }).trim();
    return { enabled: raw === "true" };
  } catch {
    return { enabled: false }; // unset (git exits non-zero) => default off
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const [hookName] = process.argv.slice(2);
  const repoRoot = process.cwd();
  const config = readConfig(repoRoot);

  if (hookName === "post-commit") {
    await handlePostCommit(defaultGitRunner, repoRoot, config, (m) => process.stderr.write(`${m}\n`));
  } else if (hookName === "post-rewrite") {
    const stdin = await readStdin();
    await handlePostRewrite(defaultGitRunner, repoRoot, config, stdin);
  }
}

main().catch((err) => {
  process.stderr.write(`[tourist] attribution hook failed (non-fatal): ${(err as Error).message}\n`);
});
