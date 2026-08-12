import * as assert from "node:assert";
import * as vscode from "vscode";
import { activateExtension, findExtension } from "./helpers.ts";

/**
 * Regression test for the "vscode.git not yet activated" crash
 * (extension.ts's `resolveGitApi` call, fixed in commit d279a9f /
 * f137d0f): the extension contributes an Explorer view, which VS Code
 * auto-activates on (`onView:tourist.workspaceAttribution`) as soon as the
 * Explorer renders it -- potentially before `vscode.git` itself has
 * finished activating. Prior to the fix, reading `vscode.git`'s `exports`
 * that early threw synchronously and took down all of `activate()`.
 */
suite("Extension activation", () => {
  test("activates without throwing and exposes its test API", async () => {
    const ext = findExtension();
    const exports = await activateExtension();

    assert.strictEqual(ext.isActive, true, "extension did not reach isActive=true -- activate() likely threw");
    assert.ok(exports, "activate() did not return its exports object");
    assert.strictEqual(
      typeof exports.getAttributedRanges,
      "function",
      "activate() returned early / partially -- getAttributedRanges export is missing"
    );
  });

  test("vscode.git extension is present and activatable alongside it", async () => {
    // Not required for Tourist to function (resolveGitApi degrades
    // gracefully if this is ever absent), but if this is present and
    // Tourist still reached isActive=true above, that's a real signal the
    // race the fix addresses did not reproduce.
    const gitExt = vscode.extensions.getExtension("vscode.git");
    if (gitExt) {
      await gitExt.activate();
      assert.strictEqual(gitExt.isActive, true);
    }
  });
});
