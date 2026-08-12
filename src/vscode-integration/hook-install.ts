/**
 * Install/verify the Claude Code hook that gives Tier 1 ("hook-covered")
 * coverage -- mandatory in this project (GOAL1.md §2), unlike tourist-raw's
 * optional `tourist.installHook`. Ported from tourist-raw's
 * `src/extension.ts` install logic, plus a new `verify` counterpart (the
 * brief explicitly asks for "install/verify hook," and mandatory-by-design
 * means users need a way to confirm it's actually active, not just a
 * fire-once install command).
 *
 * Ownership note flagged for the final report: `hooks/attribution-hook.mjs`
 * (referenced below by its expected packaged path) isn't claimed by any
 * agent in PLAN1.md's module-ownership map at all -- `spike/`, `src/core/`,
 * `src/adapters/`, `src/persistence/`, `src/vscode-integration/`,
 * `src/extension.ts`, and `test/fixtures/` are the only entries. It already
 * exists in the shared tree (adapted from tourist-raw's own hook), so this
 * module treats it as a fixed external file it references, not something
 * Agent C generates or owns -- but the ownership map should probably say so
 * explicitly.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

const HOOK_MATCHER = "Edit|Write|MultiEdit";
const HOOK_RELATIVE_PATH = path.join("hooks", "attribution-hook.mjs");

interface HookEntry {
  matcher?: string;
  hooks?: { type?: string; command?: string }[];
}

function claudeSettingsPath(): string {
  return path.join(os.homedir(), ".claude", "settings.json");
}

function hookCommand(extensionPath: string): string {
  return `node ${JSON.stringify(path.join(extensionPath, HOOK_RELATIVE_PATH))}`;
}

function readSettings(settingsPath: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    return {};
  }
}

export async function installHook(extensionPath: string): Promise<void> {
  try {
    const hookScript = path.join(extensionPath, HOOK_RELATIVE_PATH);
    if (!fs.existsSync(hookScript)) {
      vscode.window.showErrorMessage(`Tourist: hook script not found at ${hookScript}`);
      return;
    }
    const settingsPath = claudeSettingsPath();
    const settings = readSettings(settingsPath);
    const command = hookCommand(extensionPath);
    const hooks = (settings.hooks ??= {}) as Record<string, unknown>;

    let addedAny = false;
    let existedAny = false;
    for (const eventName of ["PreToolUse", "PostToolUse"]) {
      const list = (hooks[eventName] ??= []) as HookEntry[];
      if (list.some((entry) => entry.hooks?.some((h) => h.command === command))) {
        existedAny = true;
        continue;
      }
      list.push({ matcher: HOOK_MATCHER, hooks: [{ type: "command", command }] });
      addedAny = true;
    }

    if (!addedAny) {
      vscode.window.showInformationMessage("Tourist: Claude Code hook is already installed.");
      return;
    }
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
    vscode.window.showInformationMessage(
      `Tourist: Claude Code hook installed in ~/.claude/settings.json${existedAny ? " (added missing event)" : ""} — start a new Claude Code session for it to take effect.`
    );
  } catch (err) {
    vscode.window.showErrorMessage(`Tourist: could not install hook: ${(err as Error).message}`);
  }
}

export interface HookVerifyResult {
  scriptExists: boolean;
  preToolUseRegistered: boolean;
  postToolUseRegistered: boolean;
}

export function verifyHookState(extensionPath: string): HookVerifyResult {
  const hookScript = path.join(extensionPath, HOOK_RELATIVE_PATH);
  const command = hookCommand(extensionPath);
  const settings = readSettings(claudeSettingsPath());
  const hooks = (settings.hooks ?? {}) as Record<string, HookEntry[] | undefined>;
  const registered = (eventName: string) =>
    (hooks[eventName] ?? []).some((entry) => entry.hooks?.some((h) => h.command === command));

  return {
    scriptExists: fs.existsSync(hookScript),
    preToolUseRegistered: registered("PreToolUse"),
    postToolUseRegistered: registered("PostToolUse"),
  };
}

export async function verifyHook(extensionPath: string): Promise<void> {
  const result = verifyHookState(extensionPath);
  if (!result.scriptExists) {
    vscode.window.showErrorMessage(`Tourist: hook script missing at ${path.join(extensionPath, HOOK_RELATIVE_PATH)}.`);
    return;
  }
  if (result.preToolUseRegistered && result.postToolUseRegistered) {
    vscode.window.showInformationMessage("Tourist: Claude Code hook is installed and registered for both PreToolUse and PostToolUse.");
    return;
  }
  const missing = [
    !result.preToolUseRegistered ? "PreToolUse" : null,
    !result.postToolUseRegistered ? "PostToolUse" : null,
  ].filter(Boolean);
  const action = await vscode.window.showWarningMessage(
    `Tourist: hook is not fully registered (missing ${missing.join(", ")}). Tier 1 coverage is degraded until this is fixed.`,
    "Install Now"
  );
  if (action === "Install Now") await installHook(extensionPath);
}
