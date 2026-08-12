import * as assert from "node:assert";
import { activateExtension, currentWorkspaceFolder, sleep } from "./helpers.ts";

/**
 * There is no public VS Code API to ask "does view X have a real
 * TreeDataProvider, or is it showing the built-in 'no data provider
 * registered' fallback?" from outside the extension. Instead this proves
 * the *same* `WorkspaceAttributionProvider` instance that extension.ts
 * passed to `vscode.window.createTreeView("tourist.workspaceAttribution",
 * ...)` is alive and produces real rollup data for the open workspace --
 * the fallback placeholder has no such backing provider to query at all.
 */
suite("Explorer attribution tree view", () => {
  test("tourist.workspaceAttribution has a real, populated data provider", async () => {
    const testApi = await activateExtension();
    const folder = currentWorkspaceFolder();

    // `refreshWorkspaceState()` runs in a fire-and-forget IIFE during
    // activate(), not awaited by activate() itself -- poll instead of
    // assuming it has already resolved by the time this test runs.
    let nodes = testApi.getWorkspaceViewRootNodes();
    for (let i = 0; i < 20 && nodes.length === 0; i++) {
      await sleep(100);
      nodes = testApi.getWorkspaceViewRootNodes();
    }

    assert.ok(nodes.length > 0, "expected at least one root node from the real workspace-attribution provider");
    const folderNode = nodes[0];
    assert.strictEqual(folderNode.kind, "folder", `expected a "folder" root node, got: ${JSON.stringify(folderNode)}`);
    if (folderNode.kind === "folder") {
      assert.strictEqual(folderNode.folder.path, folder.uri.fsPath, "the provider's folder node does not match the open workspace folder");
    }
  });
});
