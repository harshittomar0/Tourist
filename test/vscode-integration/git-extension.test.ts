import { describe, expect, it } from "vitest";
import { resolveGitApi } from "../../src/vscode-integration/git-extension.ts";

describe("resolveGitApi", () => {
  it("returns the API when the extension is active and exports it", () => {
    const api = { repositories: [] };
    const getExtension = () => ({ exports: { getAPI: (v: number) => (v === 1 ? api : undefined) } });
    expect(resolveGitApi(getExtension, "vscode.git", 1)).toBe(api);
  });

  it("returns undefined when the extension isn't installed", () => {
    expect(resolveGitApi(() => undefined, "vscode.git", 1)).toBeUndefined();
  });

  it("returns undefined instead of throwing when .exports is read before the extension activates", () => {
    // Real VS Code behavior: `Extension.exports` is a getter that throws
    // `Error: Extension 'vscode.git' is not known or not activated` -- the
    // exact live Extension Host crash this regression test guards against.
    // Optional chaining alone (`ext?.exports?.getAPI?.(1)`) does not help
    // here since `ext` itself is truthy; only the property access throws.
    const getExtension = () => ({
      get exports(): never {
        throw new Error("Extension 'vscode.git' is not known or not activated");
      },
    });
    expect(() => resolveGitApi(getExtension, "vscode.git", 1)).not.toThrow();
    expect(resolveGitApi(getExtension, "vscode.git", 1)).toBeUndefined();
  });
});
