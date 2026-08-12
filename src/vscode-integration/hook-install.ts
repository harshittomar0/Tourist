/**
 * UI/command glue for Tier 1 hook install/verify -- mandatory in this
 * project (GOAL1.md §2), unlike tourist-raw's optional `tourist.installHook`.
 *
 * The actual settings.json read/write logic (script-path resolution,
 * `CLAUDE_CONFIG_DIR` override handling, PreToolUse/PostToolUse registration)
 * lives in exactly one place: `src/adapters/hook-log-reader.ts`'s
 * `FileHookLogReaderAdapter.install()`/`isInstalled()` -- the same instance
 * `extension.ts` already constructs and wires into the engine for the
 * Tier-1 read path. This module used to duplicate that logic with its own,
 * divergent implementation (a stale `os.homedir()`-only settings path that
 * silently ignored `CLAUDE_CONFIG_DIR`, unlike the reader's -- flagged in
 * REVIEW_JRDEV.md finding #4); it now delegates to the reader instead of
 * maintaining a second copy that can drift.
 */
import * as fs from "fs";
import * as vscode from "vscode";
import type { HookLogReaderAdapter } from "../core/adapter-interfaces.ts";

export type HookInstaller = Pick<HookLogReaderAdapter, "install" | "isInstalled">;

export async function installHook(reader: HookInstaller, hookScriptPath: string): Promise<void> {
  try {
    if (!fs.existsSync(hookScriptPath)) {
      vscode.window.showErrorMessage(`Tourist: hook script not found at ${hookScriptPath}`);
      return;
    }
    const { alreadyInstalled } = await reader.install();
    if (alreadyInstalled) {
      vscode.window.showInformationMessage("Tourist: Claude Code hook is already installed.");
      return;
    }
    vscode.window.showInformationMessage(
      "Tourist: Claude Code hook installed in ~/.claude/settings.json (or $CLAUDE_CONFIG_DIR/settings.json) — start a new Claude Code session for it to take effect."
    );
  } catch (err) {
    vscode.window.showErrorMessage(`Tourist: could not install hook: ${(err as Error).message}`);
  }
}

export interface HookVerifyResult {
  scriptExists: boolean;
  installed: boolean;
}

export async function verifyHookState(reader: HookInstaller, hookScriptPath: string): Promise<HookVerifyResult> {
  return { scriptExists: fs.existsSync(hookScriptPath), installed: await reader.isInstalled() };
}

export async function verifyHook(reader: HookInstaller, hookScriptPath: string): Promise<void> {
  const result = await verifyHookState(reader, hookScriptPath);
  if (!result.scriptExists) {
    vscode.window.showErrorMessage(`Tourist: hook script missing at ${hookScriptPath}.`);
    return;
  }
  if (result.installed) {
    vscode.window.showInformationMessage(
      "Tourist: Claude Code hook is installed and registered for both PreToolUse and PostToolUse."
    );
    return;
  }
  const action = await vscode.window.showWarningMessage(
    "Tourist: hook is not fully registered (missing PreToolUse and/or PostToolUse). Tier 1 coverage is degraded until this is fixed.",
    "Install Now"
  );
  if (action === "Install Now") await installHook(reader, hookScriptPath);
}
