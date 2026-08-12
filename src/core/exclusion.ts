import ignore from "ignore";
import * as fs from "node:fs";
import * as path from "node:path";

export interface ExclusionPredicate {
  isTracked(absolutePath: string): boolean;
}

/** Default excludes applied regardless of .gitignore contents, per the
 * locked scope (node_modules, build/dist output, .git). */
export const DEFAULT_EXCLUDES: string[] = [
  "node_modules/",
  "**/node_modules/**",
  "dist/",
  "**/dist/**",
  "build/",
  "**/build/**",
  "out/",
  "**/out/**",
  ".git/",
  "**/.git/**",
];

/**
 * Contract §1c -- the single tracking-scope/exclusion predicate, owned by
 * Agent A and reused as-is by Agent C's workspace-level view (never
 * reimplemented) so "what's tracked" can't disagree between the engine and
 * the UI. Backed by the `ignore` package (a mature, widely-used
 * .gitignore-semantics parser -- the same one ESLint/Prettier's own
 * ignore-file handling uses) rather than a hand-rolled parser, per PLAN1.md's
 * explicit preference.
 *
 * Scope limitation: only `workspaceRoot`'s own top-level .gitignore is
 * consulted, not per-directory nested .gitignore files. Replicating git's
 * full nested-.gitignore-union semantics is a reasonable future
 * enhancement, not attempted here -- the locked scope only asks for
 * ".gitignore plus common excludes", not bit-for-bit `git check-ignore`
 * parity.
 */
export function createExclusionPredicate(workspaceRoot: string, extraPatterns: readonly string[] = []): ExclusionPredicate {
  const ig = ignore();
  ig.add(DEFAULT_EXCLUDES);
  // `tourist.exclusionPolicy` -- user-supplied extra .gitignore-style
  // patterns, layered on top of the default excludes.
  if (extraPatterns.length) ig.add(extraPatterns as string[]);
  try {
    ig.add(fs.readFileSync(path.join(workspaceRoot, ".gitignore"), "utf8"));
  } catch {
    // No root .gitignore -- default excludes still apply.
  }

  return {
    isTracked(absolutePath: string): boolean {
      const rel = path.relative(workspaceRoot, absolutePath);
      if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return false;
      const posixRel = rel.split(path.sep).join("/");
      return !ig.ignores(posixRel);
    },
  };
}
