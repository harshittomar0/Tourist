const esbuild = require("esbuild");
const { globSync } = require("glob");

/**
 * Compiles the E2E harness (real @vscode/test-electron driver + Mocha
 * suite that runs inside a real extension host) to CommonJS, the same way
 * esbuild.js compiles the extension itself -- the extension host loads
 * `extensionTestsPath` via plain Node `require`, not through the project's
 * `.ts`-with-extension ESM import style.
 */
async function main() {
  const testFiles = globSync("test/e2e/suite/**/*.test.ts");

  // The driver script (invoked directly by `node`, outside any extension
  // host) and the suite index (loaded by @vscode/test-electron via
  // `extensionTestsPath`) each get their own esbuild pass.
  await esbuild.build({
    entryPoints: ["test/e2e/runTest.ts"],
    bundle: true,
    format: "cjs",
    platform: "node",
    outfile: "dist-test/runTest.js",
    external: ["@vscode/test-electron"],
    sourcemap: true,
    logLevel: "info",
  });

  await esbuild.build({
    entryPoints: ["test/e2e/suite/index.ts", ...testFiles],
    bundle: true,
    format: "cjs",
    platform: "node",
    outdir: "dist-test/suite",
    // `vscode` only exists inside a running extension host; `mocha` is a
    // plain node_modules dependency the compiled output resolves normally.
    external: ["vscode", "mocha"],
    sourcemap: true,
    logLevel: "info",
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
