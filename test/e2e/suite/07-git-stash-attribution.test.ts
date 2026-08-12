import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { activateExtension, createAndOpenFile, currentWorkspaceFolder, sleep } from "./helpers.ts";

/**
 * Real repro for the "git stash push+pop loses attribution" bug that a live
 * user reported *after* both tourist-19's reload wiring (3903d1c) and
 * tourist-21's same-line collision fix (a8fc0e8) were merged, and after both
 * those fixes' own fast/synthetic tests
 * (test/vscode-integration/git-reload.test.ts) kept passing.
 *
 * That existing suite calls `reconcileAfterGitChange` directly, immediately
 * after each real `git` command -- it never drives the actual
 * `onDidChangeTextDocument`/`markGitActivity` wiring in extension.ts, and so
 * never exercises what spike/FINDINGS.md Experiment 6 measured live:
 * `vscode.git`'s `repository.state.onDidChange` (the previous fix's only
 * signal that a git operation happened) lags the git command that caused it
 * by 1.2-3.5s, while VS Code's own file watcher notices an already-open,
 * clean document's on-disk content changing (a stash push/pop reverting it)
 * within milliseconds. This test found something worse than "the fix is a
 * bit late": driving real `git add`/`commit`/`stash push`/`stash pop`
 * commands against the real extension host, `repository.state.onDidChange`
 * fired for the workspace's very first two file writes and then *never
 * again* for the rest of the run -- so gating a reload/reconcile on that
 * signal misses a real stash pop's content revert entirely, not just late.
 *
 * Attribution is produced through real code paths, not by poking
 * `AttributionEngine` state directly:
 *  - "human": a real `editor.edit()` on an already-dirty document (same
 *    proven pattern as 04-decorations-engine.test.ts).
 *  - "ai": a real Tier-2a lock-file corroboration -- a `*.lock` file shaped
 *    exactly like the real `~/.claude/ide/*.lock` file
 *    (NodeLockFileWatcherAdapter's actual expected shape: `pid`,
 *    `workspaceFolders`), written to the *real* default lock directory (no
 *    CLAUDE_CONFIG_DIR override -- that directory is already being
 *    `fs.watch`ed from this extension's real activation, so this is the
 *    same corroboration signal a real live Claude Code session would send)
 *    with this test process's own real, alive pid, followed by a raw
 *    `fs.writeFileSync` direct to disk (bypassing the editor, so it lands as
 *    a genuine clean-before/after disk write) -- exactly the real
 *    `classifyDiskWrite` lock-file/Tier-2a path (tier-classifier.ts).
 *
 * Real ambient noise this test has to account for: creating/rewriting a
 * file inside a real git repo is itself git-status-relevant (a new
 * untracked file, or a tracked file's content changing), so it can trigger
 * the very same `repository.state.onDidChange` signal a real git command
 * would -- this test waits out that noise between setup steps rather than
 * papering over it, since it's a real characteristic of the live system,
 * not a test artifact.
 */
suite("Real git stash push/pop attribution round trip (real extension host, real timing)", () => {
  let lockFilePath: string | undefined;

  teardown(() => {
    if (lockFilePath) {
      fs.rmSync(lockFilePath, { force: true });
      lockFilePath = undefined;
    }
  });

  function git(cwd: string, args: string[]): string {
    return execFileSync(
      "git",
      ["-c", "user.name=Tourist E2E", "-c", "user.email=tourist-e2e@test", ...args],
      { cwd, encoding: "utf8" }
    ).trim();
  }

  /** Real default lock directory `NodeLockFileWatcherAdapter` watches when
   * `CLAUDE_CONFIG_DIR` isn't overridden -- already `fs.watch`ed by this
   * extension's real activation, so writing here (and only here) makes the
   * corroboration signal arrive through the adapter's real fs-event path,
   * not a poll fallback. */
  function realLockDir(): string {
    return path.join(os.homedir(), ".claude", "ide");
  }

  function writeRealLockFile(workspaceRoot: string): string {
    const dir = realLockDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `tourist-e2e-${crypto.randomUUID()}.lock`);
    fs.writeFileSync(
      file,
      JSON.stringify({ pid: process.pid, workspaceFolders: [workspaceRoot], ideName: "tourist-e2e" })
    );
    return file;
  }

  function originsOf(testApi: Awaited<ReturnType<typeof activateExtension>>, docPath: string): (string | null)[] {
    return testApi.getAttributedRanges(docPath).map((r) => r.origin ?? null);
  }

  test("survives two real stash push+pop cycles through the real activation path, real vscode.git timing included", async function () {
    // Real, unshortened waits sized to spike/FINDINGS.md Experiment 6's
    // measured 1.2-3.5s vscode.git lag (several per stash op, x2 cycles) --
    // this test is slow on purpose; that's the entire point of it existing
    // alongside the fast synthetic suite.
    this.timeout(120_000);

    const testApi = await activateExtension();
    const folder = currentWorkspaceFolder();
    const repoRoot = folder.uri.fsPath;

    const { uri, document, editor } = await createAndOpenFile("e2e-07-stash.ts", "// placeholder\n");

    // Creating this file is itself a git-status-relevant change (a new
    // untracked file appearing) -- wait it out before the next step so it
    // can't coincidentally overlap the intentional Tier-2a corroborated
    // write below.
    await sleep(6000);

    // ---- Produce a real Tier-2a "ai" range: lock-file corroboration + a
    // genuine clean-before/after disk write (not editor.edit()). Retried a
    // few times: ambient repo-status noise (this same real vscode.git
    // signal, just from something *else* touching the repo) can coincide
    // and suppress this specific write's classification back to unmarked --
    // a real, separate race in its own right, but not what this test is
    // about, so retry with backoff rather than let it flake this test. ----
    const aiBaseline = "function foo(): number {\n  return 1;\n}\n// ai-generated\n";
    let afterAiWrite: (string | null)[] = [];
    for (let attempt = 0; attempt < 4 && !afterAiWrite.some((o) => o === "ai"); attempt++) {
      lockFilePath = writeRealLockFile(repoRoot);
      await sleep(500); // real fs.watch propagation, not instant

      fs.writeFileSync(uri.fsPath, aiBaseline);
      await sleep(1000); // real file-watcher -> onDidChangeTextDocument -> engine settle

      fs.rmSync(lockFilePath, { force: true });
      lockFilePath = undefined;
      await sleep(300);

      afterAiWrite = originsOf(testApi, uri.fsPath);
      if (!afterAiWrite.some((o) => o === "ai")) await sleep(3000); // let any coincidental suppression fully close before retrying
    }
    assert.ok(
      afterAiWrite.some((o) => o === "ai"),
      `expected a real Tier-2a "ai" range after the lock-file-corroborated disk write; got origins: ${JSON.stringify(afterAiWrite)}`
    );

    // This is the baseline every stash push will fall back to.
    git(repoRoot, ["add", "e2e-07-stash.ts"]);
    git(repoRoot, ["commit", "-q", "-m", "ai baseline"]);

    // Same ambient-noise consideration as above.
    await sleep(6000);

    const afterBaselineCommit = originsOf(testApi, uri.fsPath);
    assert.ok(
      afterBaselineCommit.some((o) => o === "ai"),
      `expected the "ai" range to survive the baseline commit settling; got: ${JSON.stringify(afterBaselineCommit)}`
    );

    // ---- Real human edit on top, left uncommitted -----------------------
    // Warm-up edit first: the *first* clean-to-dirty transition on a freshly
    // reloaded document is a separate, already-documented, already-known
    // regression (04-decorations-engine.test.ts) -- not what this test is
    // about, so get past it the same proven way that test does.
    await editor.edit((eb) => eb.insert(new vscode.Position(document.lineCount, 0), "// warmup\n"));
    await sleep(300);
    await editor.edit((eb) => eb.insert(new vscode.Position(document.lineCount, 0), "// human edit\n"));
    await sleep(300);
    await document.save(); // flush to disk -- git stash needs a real on-disk diff to revert

    const beforeStash = originsOf(testApi, uri.fsPath);
    assert.ok(beforeStash.some((o) => o === "human"), `expected a "human" range before stashing; got: ${JSON.stringify(beforeStash)}`);
    assert.ok(beforeStash.some((o) => o === "ai"), `expected the "ai" range to still be there before stashing; got: ${JSON.stringify(beforeStash)}`);

    // Real debounce wait: let extension.ts's own SAVE_DEBOUNCE_MS-driven
    // persistence.save() actually fire before mutating git state under it --
    // not skipped/faked.
    await sleep(2500);

    for (let cycle = 0; cycle < 2; cycle++) {
      git(repoRoot, ["stash", "push", "-q"]);
      // Real vscode.git latency per spike/FINDINGS.md Experiment 6:
      // repository.state.onDidChange lags the git command by 1.2-3.5s (when
      // it fires at all for this op -- see this file's header comment).
      // Wait past the worst case, not an artificially shortened stand-in.
      await sleep(4500);

      const onDisk = fs.readFileSync(uri.fsPath, "utf8");
      assert.strictEqual(onDisk, aiBaseline, `cycle ${cycle}: expected git stash push to revert the file to the committed ai baseline on disk`);

      const afterPush = originsOf(testApi, uri.fsPath);
      assert.ok(
        afterPush.some((o) => o === "ai"),
        `cycle ${cycle}: expected the real extension to still show "ai" attribution for the reverted-to-baseline content after ` +
          `a real stash push (not lost/misclassified as "external"/unmarked); got origins: ${JSON.stringify(afterPush)}`
      );

      git(repoRoot, ["stash", "pop", "-q"]);
      await sleep(4500);

      const afterPop = originsOf(testApi, uri.fsPath);
      assert.ok(
        afterPop.some((o) => o === "human"),
        `cycle ${cycle}: expected "human" attribution restored after a real stash pop; got origins: ${JSON.stringify(afterPop)}`
      );
      assert.ok(
        afterPop.some((o) => o === "ai"),
        `cycle ${cycle}: expected "ai" attribution still present after a real stash pop; got origins: ${JSON.stringify(afterPop)}`
      );
    }
  });
});
