/**
 * Real end-to-end harness driver: launches an actual VS Code instance (the
 * real extension host, not a mocked `vscode` module) via
 * `@vscode/test-electron`, with this extension loaded through
 * `--extensionDevelopmentPath`, against a throwaway workspace folder on
 * disk. Every existing test under `test/` and the `src` tree's `__tests__`
 * folders mocks the `vscode` API; this is the only suite that runs inside a
 * real one.
 *
 * Invoked via `npm run test:e2e` (which first compiles this file and the
 * suite to CommonJS -- see esbuild.e2e.js -- since the extension host loads
 * `extensionTestsPath` with a plain Node `require`).
 */
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron";

function makeThrowawayWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tourist-e2e-"));
  fs.writeFileSync(
    path.join(dir, "sample.ts"),
    "export function greet(name: string): string {\n  return `hello ${name}`;\n}\n"
  );
  // A real git repo, not just a bare folder -- several code paths under
  // test (git-op suppression, branch watching) only activate when
  // `vscode.git` has a repository to report, and this harness exists to
  // exercise real code paths, not skip them.
  cp.execSync("git init -q", { cwd: dir });
  cp.execSync('git -c user.email=e2e@test -c user.name=e2e add -A', { cwd: dir });
  cp.execSync('git -c user.email=e2e@test -c user.name=e2e commit -q -m "initial"', { cwd: dir });
  return dir;
}

async function main(): Promise<void> {
  // NOTE: this file compiles to a flat `dist-test/runTest.js` (see
  // esbuild.e2e.js), one directory level shallower than its
  // `test/e2e/runTest.ts` source location -- `__dirname` here is
  // `<repo>/dist-test`, not `<repo>/test/e2e`, so this only needs one `..`,
  // not two (two would land on the *parent* of the repo, which -- when
  // repo checkouts are siblings under a shared worktrees directory, as in
  // this project's AO-managed worktrees -- silently resolves to a
  // different sibling checkout instead of failing loudly).
  const extensionDevelopmentPath = path.resolve(__dirname, "..");
  const extensionTestsPath = path.resolve(__dirname, "./suite/index.js");
  const workspaceDir = makeThrowawayWorkspace();

  try {
    const vscodeExecutablePath = await downloadAndUnzipVSCode("stable");

    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        workspaceDir,
        "--disable-workspace-trust",
        "--skip-welcome",
        "--skip-release-notes",
        "--disable-updates",
        "--disable-telemetry",
      ],
    });
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("Failed to run E2E tests:", err);
  process.exit(1);
});
