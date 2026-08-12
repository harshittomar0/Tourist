import * as vscode from "vscode";
import type { ShellIntegrationBridgeAdapter } from "../core/adapter-interfaces.ts";
import type { CorroborationSignal } from "../core/corroboration-store.ts";
import type { Disposable } from "../core/types.ts";

/**
 * Tier 2b corroboration: `onDidStartTerminalShellExecution` fires only when
 * shell integration is active for a given VS Code integrated terminal
 * (RESEARCH1.md §3). This is the one adapter that legitimately needs the
 * real `vscode` module -- it lives in src/adapters/, not src/core/, so that
 * is allowed per the ownership rules (only src/core/ must stay vscode-free).
 *
 * Phase 0 experiment 3 (spike/FINDINGS.md) confirmed real `claude`
 * invocations report `commandLine.confidence: "High"` with exact
 * `commandLine.value`/`cwd` on bash and zsh -- CONFIRMED for those two
 * shells; fish/pwsh remain genuinely UNVERIFIED (not available to test),
 * not contradicted. It also confirmed the positive "unavailable" signal:
 * `terminal.shellIntegration` is reliably falsy/absent for a terminal that
 * will never attach (tested on `sh`), distinct from "hasn't attached yet."
 * This adapter still treats "no signal" and "signal says inactive"
 * identically (both simply don't set `active: true`), which the finding's
 * decision calls conservative-safe; distinguishing them by keying off
 * `terminal.shellIntegration` directly remains a possible follow-up, not
 * implemented in this pass (comment cleanup only).
 */
const MIN_CONFIDENCE_ACCEPTED: readonly string[] = ["low", "medium", "high"];

function commandLooksLikeClaude(commandLine: string): boolean {
  return /^\s*claude(\s|$)/.test(commandLine);
}

export class VscodeShellIntegrationBridgeAdapter implements ShellIntegrationBridgeAdapter {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly listeners = new Set<(workspaceRoot: string, signal: CorroborationSignal) => void>();
  private workspaceRoots: string[] = [];

  start(workspaceRoots: string[]): void {
    this.workspaceRoots = workspaceRoots;

    this.disposables.push(
      vscode.window.onDidStartTerminalShellExecution((event) => {
        const commandLine = event.execution.commandLine;
        const confidence = String(commandLine.confidence).toLowerCase();
        if (!MIN_CONFIDENCE_ACCEPTED.includes(confidence)) return;
        if (!commandLooksLikeClaude(commandLine.value)) return;

        const cwd = event.terminal.shellIntegration?.cwd?.fsPath;
        const matchedRoot = this.workspaceRoots.find((root) => cwd === root || cwd?.startsWith(root + "/"));
        if (!matchedRoot) return;

        this.emit(matchedRoot, {
          source: "shell-integration",
          active: true,
          since: Date.now(),
          metadata: { commandLine: commandLine.value, confidence, cwd },
        });
      })
    );

    this.disposables.push(
      vscode.window.onDidEndTerminalShellExecution((event) => {
        const cwd = event.terminal.shellIntegration?.cwd?.fsPath;
        const matchedRoot = this.workspaceRoots.find((root) => cwd === root || cwd?.startsWith(root + "/"));
        if (!matchedRoot) return;
        if (!commandLooksLikeClaude(event.execution.commandLine.value)) return;

        this.emit(matchedRoot, { source: "shell-integration", active: false, since: Date.now() });
      })
    );
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }

  onDidChangeSignal(listener: (workspaceRoot: string, signal: CorroborationSignal) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private emit(workspaceRoot: string, signal: CorroborationSignal): void {
    for (const listener of this.listeners) listener(workspaceRoot, signal);
  }
}
