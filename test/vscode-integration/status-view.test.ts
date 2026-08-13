/**
 * Regression test for status-view.ts's webview message handler having zero
 * error handling (same class of bug as REVIEW_JRDEV_V2.md finding #2,
 * already fixed once in panel.ts -- see knowledge-map-panel.test.ts's header
 * comment): a thrown/rejected command dispatched from
 * `vscode.commands.executeCommand` was not surfaced anywhere, so a click on
 * (e.g.) the sidebar's "Generate" Knowledge Map button "does nothing" with
 * no visible feedback whenever the underlying command rejects. This mocks
 * the `vscode` module (there's no real extension host under vitest) to
 * capture the listener registered via `webview.onDidReceiveMessage` and
 * drive it directly, asserting failures are now surfaced via
 * `showErrorMessage` instead of disappearing silently.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { TouristStatusViewProvider } from "../../src/vscode-integration/status-view.ts";

const { showErrorMessage, executeCommand } = vi.hoisted(() => ({
  showErrorMessage: vi.fn(),
  executeCommand: vi.fn(),
}));

vi.mock("vscode", () => ({
  window: { showErrorMessage },
  commands: { executeCommand },
  workspace: {
    getConfiguration: () => ({
      get: (_key: string, def: unknown) => def,
    }),
  },
}));

type Listener = (message: unknown) => Promise<void>;

function resolveStatusView(): { listener: Listener } {
  const provider = new TouristStatusViewProvider({
    hookInstaller: { install: vi.fn(), isInstalled: vi.fn(async () => false) },
    hookScriptPath: "/unused/hook.mjs",
  });

  let listener: Listener | undefined;
  const webviewView = {
    webview: {
      options: {},
      html: "",
      cspSource: "vscode-resource:",
      onDidReceiveMessage: (l: Listener) => {
        listener = l;
        return { dispose: vi.fn() };
      },
    },
    onDidChangeVisibility: vi.fn(),
    onDidDispose: vi.fn(),
  } as unknown as vscode.WebviewView;

  provider.resolveWebviewView(webviewView);
  if (!listener) throw new Error("listener was never registered -- resolveWebviewView didn't run synchronously");
  return { listener };
}

beforeEach(() => {
  showErrorMessage.mockClear();
  executeCommand.mockClear();
});

describe("status-view.ts message handler error handling", () => {
  it("surfaces an error via showErrorMessage instead of silently doing nothing when the dispatched command rejects", async () => {
    executeCommand.mockRejectedValueOnce(new Error("analyser CLI not built"));
    const { listener } = resolveStatusView();

    await listener({ type: "action", action: "generateKnowledgeMap" });

    expect(executeCommand).toHaveBeenCalledWith("tourist.generateKnowledgeMap");
    expect(showErrorMessage).toHaveBeenCalledTimes(1);
    expect(showErrorMessage.mock.calls[0][0]).toMatch(/generateKnowledgeMap failed: analyser CLI not built/);
  });

  it("surfaces an error instead of silently no-oping when the action key doesn't match any known command", async () => {
    const { listener } = resolveStatusView();

    await listener({ type: "action", action: "notARealAction" });

    expect(executeCommand).not.toHaveBeenCalled();
    expect(showErrorMessage).toHaveBeenCalledTimes(1);
    expect(showErrorMessage.mock.calls[0][0]).toMatch(/unrecognized status view action "notARealAction"/);
  });

  it("still dispatches and refreshes normally when the command succeeds", async () => {
    executeCommand.mockResolvedValueOnce(undefined);
    const { listener } = resolveStatusView();

    await listener({ type: "action", action: "toggleTracking" });

    expect(executeCommand).toHaveBeenCalledWith("tourist.toggleTracking");
    expect(showErrorMessage).not.toHaveBeenCalled();
  });
});
