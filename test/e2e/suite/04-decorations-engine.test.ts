import * as assert from "node:assert";
import * as vscode from "vscode";
import { activateExtension, createAndOpenFile, sleep } from "./helpers.ts";

/**
 * Exercises the real pipeline end to end: open a file -> real
 * `onDidOpenTextDocument` -> real `editor.edit()` -> real
 * `onDidChangeTextDocument` -> `AttributionEngine.pushChanges` -> a real
 * `AttributedRange` recorded, and `refreshDecorations` running against it
 * without throwing. There is no public VS Code API to read back which
 * `DecorationOptions` were last passed to `TextEditor.setDecorations`, so
 * this asserts on the engine's own range output (exposed for exactly this
 * purpose via `TouristTestApi.getAttributedRanges`, see extension.ts) --
 * the input the decorations pipeline renders from.
 */
suite("Editing produces a real attribution range", () => {
  test("typing into an already-dirty open file creates a human-origin AttributedRange", async () => {
    const testApi = await activateExtension();
    const { uri, document, editor } = await createAndOpenFile(
      "e2e-04-edit.ts",
      "export function greet(name: string): string {\n  return name;\n}\n"
    );
    await sleep(300);

    // A throwaway first edit to get past the clean-document race documented
    // in the regression test below -- this test is about the steady-state
    // pipeline, not that specific bug.
    await editor.edit((eb) => eb.insert(new vscode.Position(document.lineCount, 0), "// warmup\n"));
    await sleep(200);

    const before = testApi.getAttributedRanges(uri.fsPath).length;
    await editor.edit((eb) => {
      eb.insert(new vscode.Position(document.lineCount, 0), "export const e2eMarker = true;\n");
    });
    await sleep(200);

    const after = testApi.getAttributedRanges(uri.fsPath);
    assert.ok(after.length > before, `expected a new AttributedRange after editing (before=${before}, after=${after.length})`);
    assert.ok(
      after.some((r) => r.origin === "human"),
      `expected at least one "human" range from a direct, uncorroborated editor edit; got origins: ${after.map((r) => r.origin).join(", ")}`
    );
  });

  /**
   * NEW FINDING (not a known in-flight fix -- checked branches/commits for
   * "dirty"/"isDirty" and found nothing; the closest related work is
   * tourist-18's git-op-suppression race and tourist-19's branch/stash
   * reload, neither of which touches this): the very first edit to a
   * freshly-opened, clean document is misattributed.
   *
   * extension.ts's `onDidChangeTextDocument` reads `event.document.isDirty`
   * synchronously to compute `dirtyAfter` (change-listener.ts's
   * `toNormalizedChangeBatch`). For a document's first-ever clean-to-dirty
   * transition, VS Code fires *two* change events for one `editor.edit()`
   * call: the first carries the real content change but `isDirty` still
   * reads its pre-edit value (`false`) at that instant; a second event
   * immediately follows carrying the corrected `isDirty=true` but with an
   * empty `contentChanges` (so `toNormalizedChangeBatch` discards it, see
   * change-listener.ts line 50). The result: `wouldBeDiskWrite` is computed
   * from `dirtyBefore=false, dirtyAfter=false` (both stale-false) and the
   * classifier takes the disk-write branch instead of `{ origin: "human" }`
   * -- confirmed below: the inserted text merges into the unmarked
   * (`origin: null`) baseline range instead of getting its own "human"
   * range. A *second* edit on the same (now genuinely dirty) document
   * classifies correctly, per the passing test above.
   *
   * Real-world impact: the first line a human (or Claude Code) writes into
   * a newly opened, unmodified file is attributed as unmarked/external
   * instead of correctly as human or ai.
   */
  test("REGRESSION (new, unfixed): first edit on a freshly-opened clean document is misattributed", async () => {
    const testApi = await activateExtension();
    const { uri, document, editor } = await createAndOpenFile(
      "e2e-04-first-edit-bug.ts",
      "export function greet(name: string): string {\n  return name;\n}\n"
    );
    await sleep(300);

    await editor.edit((eb) => {
      eb.insert(new vscode.Position(document.lineCount, 0), "export const e2eMarker = true;\n");
    });
    await sleep(200);

    const ranges = testApi.getAttributedRanges(uri.fsPath);
    assert.ok(
      ranges.some((r) => r.origin === "human"),
      `expected the first edit on a freshly-opened clean document to be attributed "human"; ` +
        `got origins: [${ranges.map((r) => r.origin).join(", ")}] -- see this test's doc comment for the root cause`
    );
  });
});
