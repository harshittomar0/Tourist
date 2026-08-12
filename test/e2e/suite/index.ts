/**
 * Loaded by the real extension host via `extensionTestsPath` (a plain Node
 * `require`, hence the CommonJS compile step in esbuild.e2e.js). Sets up
 * Mocha's TDD interface (`suite`/`test` globals) before requiring any spec
 * file, since a spec file calling `suite(...)` at module-load time needs
 * that global to already exist.
 */
import * as path from "node:path";
import Mocha from "mocha";
import { globSync } from "glob";

export function run(): Promise<void> {
  const mocha = new Mocha({
    ui: "tdd",
    color: true,
    timeout: 60_000,
  });

  const testsRoot = __dirname;
  const files = globSync("**/*.test.js", { cwd: testsRoot });
  for (const file of files) mocha.addFile(path.resolve(testsRoot, file));

  return new Promise((resolve, reject) => {
    try {
      mocha.run((failures) => {
        if (failures > 0) reject(new Error(`${failures} E2E test(s) failed.`));
        else resolve();
      });
    } catch (err) {
      reject(err);
    }
  });
}
