import { test, describe } from "vitest";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createExclusionPredicate } from "../../src/core/exclusion.ts";

function withWorkspace(gitignore: string | null, run: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tourist-exclusion-"));
  try {
    if (gitignore !== null) fs.writeFileSync(path.join(root, ".gitignore"), gitignore, "utf8");
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("createExclusionPredicate", () => {
  test("default excludes apply even with no .gitignore", () => {
    withWorkspace(null, (root) => {
      const predicate = createExclusionPredicate(root);
      assert.equal(predicate.isTracked(path.join(root, "node_modules", "x", "index.js")), false);
      assert.equal(predicate.isTracked(path.join(root, "dist", "out.js")), false);
      assert.equal(predicate.isTracked(path.join(root, ".git", "HEAD")), false);
      assert.equal(predicate.isTracked(path.join(root, "src", "index.ts")), true);
    });
  });

  test("respects the workspace root's .gitignore", () => {
    withWorkspace("*.log\nsecrets/\n", (root) => {
      const predicate = createExclusionPredicate(root);
      assert.equal(predicate.isTracked(path.join(root, "debug.log")), false);
      assert.equal(predicate.isTracked(path.join(root, "secrets", "key.pem")), false);
      assert.equal(predicate.isTracked(path.join(root, "src", "index.ts")), true);
    });
  });

  test("a path outside the workspace root is never tracked", () => {
    withWorkspace(null, (root) => {
      const predicate = createExclusionPredicate(root);
      assert.equal(predicate.isTracked(path.join(os.tmpdir(), "elsewhere.ts")), false);
    });
  });

  test("negation patterns (re-including a subpath) are honored, since `ignore` implements full gitignore semantics", () => {
    // Deliberately uses a directory name ("vendor/") that does not collide
    // with DEFAULT_EXCLUDES -- git's own semantics (faithfully replicated by
    // the `ignore` package) don't let a later "!" negation un-ignore a path
    // *inside* a directory that a trailing-slash pattern already excluded
    // (git never descends into it to check), so testing this against
    // "build/" -- one of our own default excludes -- would fail for a
    // reason unrelated to what this test is actually checking.
    withWorkspace("vendor/*\n!vendor/keep.txt\n", (root) => {
      const predicate = createExclusionPredicate(root);
      assert.equal(predicate.isTracked(path.join(root, "vendor", "output.js")), false);
      assert.equal(predicate.isTracked(path.join(root, "vendor", "keep.txt")), true);
    });
  });
});
