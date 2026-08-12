import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { TouristTestApi } from "../../../src/extension.ts";

const EXTENSION_NAME = "tourist";

export function findExtension(): vscode.Extension<TouristTestApi> {
  const ext = vscode.extensions.all.find((e) => e.packageJSON?.name === EXTENSION_NAME) as
    | vscode.Extension<TouristTestApi>
    | undefined;
  if (!ext) throw new Error(`Extension "${EXTENSION_NAME}" not found among ${vscode.extensions.all.length} loaded extensions.`);
  return ext;
}

export async function activateExtension(): Promise<TouristTestApi> {
  const ext = findExtension();
  return ext.isActive ? ext.exports : await ext.activate();
}

/** Monkey-patches `vscode.window.show*Message` for the duration of `fn`,
 * capturing what was shown and auto-resolving with `respondWith` instead of
 * leaving a real modal notification waiting for a human click (which would
 * hang the suite forever in headless CI). */
export async function captureMessages<T>(
  fn: () => Thenable<T>,
  respondWith?: string
): Promise<{ result: T; infos: string[]; warnings: string[]; errors: string[] }> {
  const infos: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const originalInfo = vscode.window.showInformationMessage;
  const originalWarn = vscode.window.showWarningMessage;
  const originalErr = vscode.window.showErrorMessage;

  (vscode.window as any).showInformationMessage = (msg: string, ...rest: unknown[]) => {
    infos.push(msg);
    return Promise.resolve(respondWith as unknown as string | undefined);
  };
  (vscode.window as any).showWarningMessage = (msg: string, ...rest: unknown[]) => {
    warnings.push(msg);
    return Promise.resolve(respondWith as unknown as string | undefined);
  };
  (vscode.window as any).showErrorMessage = (msg: string, ...rest: unknown[]) => {
    errors.push(msg);
    return Promise.resolve(respondWith as unknown as string | undefined);
  };

  try {
    const result = await fn();
    return { result, infos, warnings, errors };
  } finally {
    vscode.window.showInformationMessage = originalInfo;
    vscode.window.showWarningMessage = originalWarn;
    vscode.window.showErrorMessage = originalErr;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function currentWorkspaceFolder(): vscode.WorkspaceFolder {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error("No workspace folder open -- the E2E runner should have opened the throwaway workspace.");
  return folder;
}

/** Creates a file unique to the calling test (`name` should be test-specific,
 * e.g. "e2e-04-edit.ts") and opens it in an editor. Each test that edits a
 * document gets its own file rather than sharing one across test files --
 * the whole suite runs in a single, long-lived extension host, so a shared
 * file accumulates cross-test document/engine state and makes assertions
 * order-dependent. */
export async function createAndOpenFile(
  name: string,
  content: string
): Promise<{ uri: vscode.Uri; document: vscode.TextDocument; editor: vscode.TextEditor }> {
  const folder = currentWorkspaceFolder();
  const filePath = path.join(folder.uri.fsPath, name);
  fs.writeFileSync(filePath, content);
  const uri = vscode.Uri.file(filePath);
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document);
  return { uri, document, editor };
}
