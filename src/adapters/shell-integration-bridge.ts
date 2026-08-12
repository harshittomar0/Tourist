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
 * TODO(Phase 0 experiment 3): this currently treats *any*
 * `commandLine.confidence` value as sufficient corroboration once the
 * command line starts with "claude" and `cwd` matches a tracked workspace
 * root. Experiment 3 determines whether `commandLine.confidence` is
 * reliably "high" for a real `claude` invocation across bash/zsh/fish/pwsh
 * on the actual target machines, or whether "Low"/"None"-confidence matches
 * should be excluded from corroboration (`MIN_CONFIDENCE` below is the one
 * line to change once that's known). It also determines how to positively
 * detect "shell integration isn't available at all here" (a `commandLine`
 * with `confidence` "none" or an execution's `commandLine.value` being
 * empty) versus "shell integration says no claude is running" -- this
 * adapter does not yet distinguish those two cases in its emitted signal;
 * downstream tier-classification currently treats "no signal" and "signal
 * says inactive" identically (both simply don't set `active: true`), which
 * is conservative-safe (never over-corroborates) but may under-corroborate
 * in the "unavailable" case. Revisit once experiment 3 lands.
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
