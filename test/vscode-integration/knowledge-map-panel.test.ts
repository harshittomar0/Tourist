/**
 * Regression tests for panel.ts's webview message handler having zero error
 * handling (see REVIEW_JRDEV_V2.md finding #2): a thrown error inside the
 * async callback passed to `webview.onDidReceiveMessage` is not surfaced by
 * VS Code the way it is for a registered command -- it just becomes a
 * rejected promise nobody awaits, so a click "does nothing" with no visible
 * feedback. These tests mock the `vscode` module (there's no real
 * extension host under vitest) to capture the registered listener and drive
 * it directly, asserting that failures are now surfaced via
 * showErrorMessage/showWarningMessage instead of disappearing silently.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { _resetForTests, showKnowledgeMapPanel } from "../../src/vscode-integration/knowledge-map/panel.ts";

// vi.mock calls (and anything referenced inside them, via vi.hoisted) are
// hoisted above all imports -- including the static imports above -- so
// panel.ts's `import * as vscode from "vscode"` resolves to this mock.
// There's no real extension host under vitest.
const { showErrorMessage, showWarningMessage } = vi.hoisted(() => ({
  showErrorMessage: vi.fn(),
  showWarningMessage: vi.fn(),
}));

vi.mock("vscode", () => ({
  window: { showErrorMessage, showWarningMessage, createWebviewPanel: vi.fn() },
  ViewColumn: { Beside: 2 },
  Uri: { file: (p: string) => ({ fsPath: p }) },
}));

type Listener = (message: unknown) => Promise<void>;

/** Stubs the next `createWebviewPanel()` call and returns a getter for the
 * listener panel.ts registers via `webview.onDidReceiveMessage` -- the thing
 * under test in every case below. */
function stubNextPanel(): { getListener: () => Listener } {
  let listener: Listener | undefined;
  (vscode.window.createWebviewPanel as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
    webview: {
      cspSource: "vscode-resource:",
      html: "",
      onDidReceiveMessage: (l: Listener) => {
        listener = l;
        return { dispose: vi.fn() };
      },
    },
    onDidDispose: vi.fn(),
    reveal: vi.fn(),
  }));
  return {
    getListener: () => {
      if (!listener) throw new Error("listener was never registered -- showKnowledgeMapPanel wasn't awaited yet");
      return listener;
    },
  };
}

let extensionPath: string;
let dataDir: string;
let forestJsonPath: string;

function setUpExtensionDir(): void {
  extensionPath = mkdtempSync(path.join(tmpdir(), "knowledge-map-panel-"));
  const kfDir = path.join(extensionPath, "ideation", "knowledge-forest");
  mkdirSync(path.join(kfDir, "ui"), { recursive: true });
  writeFileSync(path.join(kfDir, "ui", "knowledge-forest.html"), "<html><body></body></html>", "utf8");
  mkdirSync(path.join(kfDir, "analyser"), { recursive: true }); // no dist/ -- loadMergeForest degrades to undefined
  dataDir = path.join(kfDir, "data");
  mkdirSync(dataDir, { recursive: true });
  forestJsonPath = path.join(dataDir, "forest.json");
}

async function openPanel(): Promise<Listener> {
  const stub = stubNextPanel();
  const context = { extensionPath } as unknown as vscode.ExtensionContext;
  // hookInstaller/hookScriptPath are only read by the Hook Setup tab (see
  // panel.ts's render()); every case here stays on the default
  // "knowledge-map" tab, so these are unused stubs satisfying the type.
  await showKnowledgeMapPanel(context, {
    onDeepDive: vi.fn(async () => {}),
    onReopen: vi.fn(async () => {}),
    hookInstaller: { install: vi.fn(), isInstalled: vi.fn() },
    hookScriptPath: "/unused/hook.mjs",
  });
  return stub.getListener();
}

beforeEach(() => {
  showErrorMessage.mockClear();
  showWarningMessage.mockClear();
  _resetForTests();
  setUpExtensionDir();
});

afterEach(() => {
  chmodSync(dataDir, 0o755); // undo any permission change a test made, or rmSync below can fail
  rmSync(extensionPath, { recursive: true, force: true });
});

describe("panel.ts message handler error handling", () => {
  it("surfaces an error via showErrorMessage instead of silently doing nothing when saveForest fails", async () => {
    // forest.json deliberately doesn't exist yet -- saveForest must *create*
    // it, which is what actually needs write permission on the directory
    // (overwriting an already-existing, already-writable file wouldn't
    // exercise the failure this test is after).
    const listener = await openPanel();

    // Make the write that saveForest performs fail for a real, forced
    // reason (no write permission on the containing directory) rather than
    // mocking fs -- exercises the actual unguarded fs.writeFileSync path.
    chmodSync(dataDir, 0o555);

    await listener({ type: "nodeOverride", forest: "tech", path: [], action: "addChild", value: "Something new" });

    expect(showErrorMessage).toHaveBeenCalledTimes(1);
    expect(showErrorMessage.mock.calls[0][0]).toMatch(/Knowledge Map action failed/);
    expect(showWarningMessage).not.toHaveBeenCalled();
  });

  it("surfaces a warning instead of silently no-oping when applyOverride rejects a duplicate sibling label", async () => {
    writeFileSync(
      forestJsonPath,
      JSON.stringify({ tech: [{ label: "Existing", provenance: "ai", proficiency: 1, children: [], latent: [] }], cs: [], practice: [] }),
      "utf8"
    );
    const listener = await openPanel();

    await listener({ type: "nodeOverride", forest: "tech", path: [], action: "addChild", value: "Existing" });

    expect(showWarningMessage).toHaveBeenCalledTimes(1);
    expect(showWarningMessage.mock.calls[0][0]).toMatch(/already exists/);
    expect(showErrorMessage).not.toHaveBeenCalled();
  });

  it("surfaces an error instead of silently doing nothing when forest.json is corrupted at the moment of the click", async () => {
    // Valid at panel-open time so the initial render succeeds cleanly...
    writeFileSync(forestJsonPath, JSON.stringify({ tech: [], cs: [], practice: [] }), "utf8");
    const listener = await openPanel();
    expect(showWarningMessage).not.toHaveBeenCalled(); // clean initial render

    // ...then gets corrupted (e.g. a killed mid-write) before the next click.
    writeFileSync(forestJsonPath, "{ not json", "utf8");

    await listener({ type: "nodeOverride", forest: "tech", path: [], action: "addChild", value: "Something new" });

    expect(showErrorMessage).toHaveBeenCalledTimes(1);
    expect(showErrorMessage.mock.calls[0][0]).toMatch(/Knowledge Map action failed/);
  });
});
