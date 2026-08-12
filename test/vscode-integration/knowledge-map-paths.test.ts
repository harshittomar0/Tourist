import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAnalyserPaths } from "../../src/vscode-integration/knowledge-map/paths.ts";

let extensionPath: string;

beforeEach(() => {
  extensionPath = mkdtempSync(path.join(tmpdir(), "knowledge-map-paths-"));
});

afterEach(() => {
  rmSync(extensionPath, { recursive: true, force: true });
});

describe("resolveAnalyserPaths", () => {
  it("computes paths relative to the extension install directory", () => {
    const paths = resolveAnalyserPaths(extensionPath);
    expect(paths.analyserDir).toBe(path.join(extensionPath, "ideation", "knowledge-forest", "analyser"));
    expect(paths.cliJsPath).toBe(path.join(paths.analyserDir, "dist", "cli.js"));
    expect(paths.forestJsonPath).toBe(path.join(extensionPath, "ideation", "knowledge-forest", "data", "forest.json"));
    expect(paths.htmlPath).toBe(path.join(extensionPath, "ideation", "knowledge-forest", "ui", "knowledge-forest.html"));
  });

  it("reports cliBuilt: false when dist/cli.js doesn't exist", () => {
    expect(resolveAnalyserPaths(extensionPath).cliBuilt).toBe(false);
  });

  it("reports cliBuilt: true once dist/cli.js exists", () => {
    const cliDir = path.join(extensionPath, "ideation", "knowledge-forest", "analyser", "dist");
    mkdirSync(cliDir, { recursive: true });
    writeFileSync(path.join(cliDir, "cli.js"), "// stub", "utf8");
    expect(resolveAnalyserPaths(extensionPath).cliBuilt).toBe(true);
  });
});
