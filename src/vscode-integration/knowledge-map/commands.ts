/**
 * Registers "Tourist: Generate Knowledge Map" and "Tourist: Show Knowledge
 * Map". Owns the one piece of state that has to live above both commands:
 * `runGenerateKnowledgeMap` is shared between the command itself and the
 * webview's "Deep Dive on Selected" button and per-node "Re-review" button
 * (via panel.ts's `onDeepDive`/`onReopen` callbacks) specifically so the
 * consent dialog and enabled-gate can never be bypassed by triggering a run
 * from the panel instead of the command palette.
 */
import * as vscode from "vscode";
import * as settings from "../settings.ts";
import { buildAnalyserArgs, looksLikeUnsupportedFlags, runAnalyserCli } from "./generate.ts";
import { resolveAnalyserPaths } from "./paths.ts";
import { showKnowledgeMapPanel } from "./panel.ts";

const CONSENT_KEY = "tourist.knowledgeMap.consented";
/** Separate one-time consent gate for `--include-prompts` specifically --
 * it sends raw Claude Code conversation history, not just code, so it gets
 * its own explicit dialog rather than being folded into CONSENT_KEY's
 * generic wording. Re-asked if the setting is ever turned on after the
 * user already consented to the generic gate. */
const PROMPTS_CONSENT_KEY = "tourist.knowledgeMap.promptsConsented";
const API_KEY_SECRET = "tourist.knowledgeMap.anthropicApiKey";

export function registerKnowledgeMapCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("tourist.generateKnowledgeMap", () => runGenerateKnowledgeMap(context)),
    vscode.commands.registerCommand("tourist.showKnowledgeMap", () =>
      showKnowledgeMapPanel(context, {
        onDeepDive: (topics) => runGenerateKnowledgeMap(context, { deepDiveTopics: topics }),
        onReopen: (topic) => runGenerateKnowledgeMap(context, { reopenTopics: [topic] }),
      })
    )
  );
}

export interface RunGenerateOptions {
  deepDiveTopics?: string[];
  /** Node label(s) explicitly opted into re-review for this run only -- see
   * html.ts's "Re-review" affordance and generate.ts's `--reopen` wiring. */
  reopenTopics?: string[];
}

/**
 * The full gated flow: enabled-check -> one-time consent -> (api-key
 * backend only) secret prompt -> spawn the analyser CLI -> report outcome.
 * Used by both the command palette entry and the webview's deep-dive
 * button -- same gates apply regardless of trigger, per design.
 */
export async function runGenerateKnowledgeMap(context: vscode.ExtensionContext, opts: RunGenerateOptions = {}): Promise<void> {
  if (!settings.isKnowledgeMapEnabled()) {
    const pick = await vscode.window.showInformationMessage(
      "Tourist: Knowledge Map is off. Turn on \"tourist.knowledgeMap.enabled\" in Settings to use this feature.",
      "Open Settings"
    );
    if (pick === "Open Settings") {
      await vscode.commands.executeCommand("workbench.action.openSettings", "tourist.knowledgeMap");
    }
    return;
  }

  const backend = settings.knowledgeMapClaudeBackend();
  const consented = context.globalState.get<boolean>(CONSENT_KEY, false);
  if (!consented) {
    const choice = await vscode.window.showWarningMessage(
      `Tourist: Generating a Knowledge Map sends evidence from this repo (recent git diffs and commit messages) to Claude, via the "${backend}" backend configured in Settings. Continue?`,
      { modal: true },
      "Confirm",
      "Cancel"
    );
    if (choice !== "Confirm") return;
    await context.globalState.update(CONSENT_KEY, true);
  }

  const includePrompts = settings.knowledgeMapIncludePrompts();
  if (includePrompts) {
    const promptsConsented = context.globalState.get<boolean>(PROMPTS_CONSENT_KEY, false);
    if (!promptsConsented) {
      const choice = await vscode.window.showWarningMessage(
        `Tourist: "tourist.knowledgeMap.includePrompts" is on. In addition to git diffs and commit messages, this will send the raw text of your Claude Code conversation history in this repo -- the actual prompts and questions you typed, not just code -- to Claude. This is more sensitive than plain git history. Continue?`,
        { modal: true },
        "Confirm",
        "Cancel"
      );
      if (choice !== "Confirm") return;
      await context.globalState.update(PROMPTS_CONSENT_KEY, true);
    }
  }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    vscode.window.showErrorMessage("Tourist: open a workspace folder first.");
    return;
  }

  const paths = resolveAnalyserPaths(context.extensionPath);
  if (!paths.cliBuilt) {
    vscode.window.showErrorMessage(
      `Tourist: the knowledge-forest analyser hasn't been built yet (expected ${paths.cliJsPath}). Run "npm install && npm run build" inside ideation/knowledge-forest/analyser first.`
    );
    return;
  }

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (backend === "api-key") {
    let apiKey = await context.secrets.get(API_KEY_SECRET);
    if (!apiKey) {
      apiKey = await vscode.window.showInputBox({
        prompt: "Anthropic API key for Knowledge Map generation",
        password: true,
        ignoreFocusOut: true,
      });
      if (!apiKey) return;
      await context.secrets.store(API_KEY_SECRET, apiKey);
    }
    env.ANTHROPIC_API_KEY = apiKey;
  }

  const args = buildAnalyserArgs({
    repoRoot: workspaceRoot,
    forestJsonPath: paths.forestJsonPath,
    claudeBackend: backend,
    claudeCliPath: settings.knowledgeMapClaudeCliPath(),
    model: settings.knowledgeMapModel(),
    since: settings.knowledgeMapSince(),
    maxCommits: settings.knowledgeMapMaxCommits(),
    forestKinds: settings.knowledgeMapForestKinds(),
    includePrompts,
    deepDiveTopics: opts.deepDiveTopics,
    reopenTopics: opts.reopenTopics,
  });

  const label = opts.reopenTopics?.length
    ? `re-review of ${opts.reopenTopics.join(", ")}`
    : opts.deepDiveTopics?.length
      ? `deep dive on ${opts.deepDiveTopics.join(", ")}`
      : "Knowledge Map";
  vscode.window.showInformationMessage(`Tourist: generating ${label}…`);
  const { code, stderr } = await runAnalyserCli(paths.cliJsPath, args, env);

  if (code === 0) {
    vscode.window.showInformationMessage(
      `Tourist: ${label} updated. Run "Tourist: Show Knowledge Map" to view it.`
    );
    return;
  }

  if (looksLikeUnsupportedFlags(stderr)) {
    vscode.window.showWarningMessage(
      `Tourist: the built analyser CLI at ${paths.cliJsPath} doesn't recognize one of the flags this extension passes it. Try "npm install && npm run build" inside ideation/knowledge-forest/analyser to pick up the latest CLI. Nothing was sent.`
    );
    return;
  }

  vscode.window.showErrorMessage(`Tourist: ${label} generation failed: ${stderr.trim().slice(0, 500) || "unknown error"}`);
}
