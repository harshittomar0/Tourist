import * as assert from "node:assert";
import * as vscode from "vscode";
import { activateExtension, captureMessages } from "./helpers.ts";

const CONFIG = "tourist";

suite("Knowledge Map default-off gate", () => {
  test("tourist.knowledgeMap.enabled defaults to false", async () => {
    await activateExtension();
    const inspect = vscode.workspace.getConfiguration(CONFIG).inspect<boolean>("knowledgeMap.enabled");
    assert.strictEqual(inspect?.defaultValue, false, "knowledgeMap.enabled's package.json default is not false");
    // Nothing in this workspace/user scope overrides it for this throwaway
    // workspace, so the effective value should also read false.
    assert.strictEqual(vscode.workspace.getConfiguration(CONFIG).get<boolean>("knowledgeMap.enabled"), false);
  });

  test('"Generate Knowledge Map" explains it is disabled instead of silently no-oping', async () => {
    await activateExtension();
    assert.strictEqual(
      vscode.workspace.getConfiguration(CONFIG).get<boolean>("knowledgeMap.enabled"),
      false,
      "precondition: knowledgeMap.enabled must be off for this test to be meaningful"
    );

    const { infos, warnings, errors } = await captureMessages(() =>
      vscode.commands.executeCommand("tourist.generateKnowledgeMap")
    );

    assert.strictEqual(errors.length, 0, `expected no error messages, got: ${errors.join(" | ")}`);
    const shown = [...infos, ...warnings];
    assert.strictEqual(shown.length, 1, `expected exactly one explanatory message, got ${shown.length}: ${shown.join(" | ")}`);
    assert.match(
      shown[0],
      /knowledge map is off/i,
      `expected the message to explain the feature is off, got: "${shown[0]}"`
    );
    assert.match(shown[0], /tourist\.knowledgeMap\.enabled/, `expected the message to name the setting to flip, got: "${shown[0]}"`);
  });
});
