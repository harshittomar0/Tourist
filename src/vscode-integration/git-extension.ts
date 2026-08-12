/**
 * Real VS Code's `vscode.Extension.exports` is a getter that *throws*
 * `Error: Extension '<id>' is not known or not activated` when read before
 * that extension has finished activating -- confirmed via a live
 * Extension Host crash: Tourist's own `onView:tourist.workspaceAttribution`
 * activation event (auto-added by VS Code for the contributed Explorer
 * view) can fire *before* `vscode.git`'s `*` activation event resolves, and
 * `gitExtension?.exports?.getAPI?.(1)` doesn't help -- optional chaining
 * only guards `null`/`undefined`, not a property access that itself throws.
 * That uncaught throw took down all of `activate()` before it reached any
 * command or view registration.
 */
export function resolveGitApi<T>(
  getExtension: (id: string) => { readonly exports?: unknown } | undefined,
  extensionId: string,
  apiVersion: number
): T | undefined {
  try {
    const ext = getExtension(extensionId);
    return (ext?.exports as { getAPI?: (version: number) => T } | undefined)?.getAPI?.(apiVersion);
  } catch {
    return undefined;
  }
}
