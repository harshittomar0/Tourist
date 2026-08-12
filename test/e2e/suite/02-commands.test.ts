import * as assert from "node:assert";
import * as vscode from "vscode";
import { activateExtension, findExtension } from "./helpers.ts";

/**
 * Regression coverage for the "command not found" class of bug: every
 * command listed in package.json's contributes.commands must actually be
 * registered with VS Code after activation, not just declared.
 */
suite("Contributed commands", () => {
  test("every contributes.commands entry is registered", async () => {
    await activateExtension();

    const ext = findExtension();
    const declared: string[] = (ext.packageJSON?.contributes?.commands ?? []).map((c: { command: string }) => c.command);
    assert.ok(declared.length > 0, "package.json declares no contributes.commands -- test fixture assumption broke");

    const registered = new Set(await vscode.commands.getCommands(true));
    const missing = declared.filter((cmd) => !registered.has(cmd));

    assert.deepStrictEqual(missing, [], `commands declared in package.json but not registered: ${missing.join(", ")}`);
  });
});
