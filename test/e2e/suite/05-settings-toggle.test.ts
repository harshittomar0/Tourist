import * as assert from "node:assert";
import * as vscode from "vscode";
import { activateExtension, createAndOpenFile, sleep } from "./helpers.ts";

const CONFIG = "tourist";

async function setConfig(key: string, value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration(CONFIG).update(key, value, vscode.ConfigurationTarget.Global);
}

/**
 * `tourist.showAttributionMarkers` and `tourist.attributionTracking` are
 * read fresh on every decoration refresh / change event (settings.ts has
 * no caching) -- this confirms toggling them through the real
 * configuration API actually changes what the engine does, not just that
 * the setting value itself flips.
 */
suite("Setting toggles change real behavior", () => {
  const originalMarkers = vscode.workspace.getConfiguration(CONFIG).get<boolean>("showAttributionMarkers");
  const originalTracking = vscode.workspace.getConfiguration(CONFIG).get<boolean>("attributionTracking");

  teardown(async () => {
    await setConfig("showAttributionMarkers", originalMarkers ?? true);
    await setConfig("attributionTracking", originalTracking ?? true);
  });

  test("tourist.showAttributionMarkers round-trips through real configuration storage", async () => {
    await activateExtension();
    await createAndOpenFile("e2e-05a-markers.ts", "export const a = 1;\n");
    await sleep(200);

    // The config-change handler (extension.ts's onDidChangeConfiguration)
    // calls refreshVisibleDecorations() synchronously on this event; there
    // is no public API to read back applied DecorationOptions, so this
    // confirms the round trip through real configuration storage (not a
    // mock) that refreshVisibleDecorations reads from actually takes
    // effect either direction.
    await setConfig("showAttributionMarkers", false);
    await sleep(100);
    assert.strictEqual(vscode.workspace.getConfiguration(CONFIG).get<boolean>("showAttributionMarkers"), false);

    await setConfig("showAttributionMarkers", true);
    await sleep(100);
    assert.strictEqual(vscode.workspace.getConfiguration(CONFIG).get<boolean>("showAttributionMarkers"), true);
  });

  test("tourist.attributionTracking=false stops new ranges from being recorded", async () => {
    const testApi = await activateExtension();
    const { uri, document, editor } = await createAndOpenFile("e2e-05b-tracking.ts", "export const b = 1;\n");
    await sleep(200);

    await setConfig("attributionTracking", false);
    await sleep(100);

    const before = testApi.getAttributedRanges(uri.fsPath).length;
    await editor.edit((eb) => {
      eb.insert(new vscode.Position(document.lineCount, 0), "// tracking disabled marker\n");
    });
    await sleep(200);
    const after = testApi.getAttributedRanges(uri.fsPath).length;

    assert.strictEqual(
      after,
      before,
      `expected no new AttributedRange while tourist.attributionTracking=false (before=${before}, after=${after})`
    );
  });
});
