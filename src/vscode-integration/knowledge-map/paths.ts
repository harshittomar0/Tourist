/**
 * Resolves the on-disk locations of the ideation/knowledge-forest/ spike
 * relative to this extension's install directory.
 *
 * KNOWN LIMITATION, documented rather than papered over (same honesty
 * standard PLAN.md holds itself to): this assumes `ideation/` ships
 * alongside `dist/extension.js`, which is only true when running from a
 * source checkout (dev/F5), not from a packaged .vsix -- ideation/ is
 * deliberately excluded from this project's own build (see PLAN.md's
 * "Scope boundary"), so a packaged build has no analyser to invoke at all
 * yet. Fixing that is a packaging decision for whoever promotes this out of
 * spike status, not something to guess at here.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface AnalyserPaths {
  analyserDir: string;
  cliJsPath: string;
  forestJsonPath: string;
  htmlPath: string;
  /** Whether `npm run build` has been run inside analyser/ -- i.e. whether
   * `dist/cli.js` actually exists yet. */
  cliBuilt: boolean;
}

export function resolveAnalyserPaths(extensionPath: string): AnalyserPaths {
  const knowledgeForestDir = path.join(extensionPath, "ideation", "knowledge-forest");
  const analyserDir = path.join(knowledgeForestDir, "analyser");
  const cliJsPath = path.join(analyserDir, "dist", "cli.js");
  return {
    analyserDir,
    cliJsPath,
    forestJsonPath: path.join(knowledgeForestDir, "data", "forest.json"),
    htmlPath: path.join(knowledgeForestDir, "ui", "knowledge-forest.html"),
    cliBuilt: fs.existsSync(cliJsPath),
  };
}
