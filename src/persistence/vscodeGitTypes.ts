/**
 * Minimal ambient shape of the built-in `vscode.git` extension's API that
 * persistence relies on. Deliberately NOT the full `@types/vscode` +
 * `vscode.git` typings — persistence must not depend on the `vscode` module
 * (that's src/vscode-integration's job to import and inject). This keeps the
 * module runnable and unit-testable outside an extension host.
 *
 * src/vscode-integration is expected to do:
 *   const gitExt = vscode.extensions.getExtension('vscode.git');
 *   const api = gitExt?.exports.getAPI(1);
 *   // then pass `api` into resolveGitContext / BranchWatcher below.
 */

export interface VscodeGitRepositoryState {
  HEAD?: { name?: string; commit?: string } | null;
  onDidChange(listener: () => void): { dispose(): void };
}

export interface VscodeGitRepository {
  rootUri: { fsPath: string };
  state: VscodeGitRepositoryState;
}

export interface VscodeGitAPI {
  repositories: VscodeGitRepository[];
  onDidOpenRepository(listener: (repo: VscodeGitRepository) => void): { dispose(): void };
  getRepository(uri: { fsPath: string }): VscodeGitRepository | null;
}
