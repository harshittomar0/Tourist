/**
 * Files under src/vscode-integration/ that `import * as vscode from "vscode"`
 * at runtime (commands.ts, settings.ts, this feature's commands.ts) aren't
 * unit-testable outside the extension host -- see the existing
 * test/vscode-integration/ suite, which only covers modules that avoid a
 * runtime vscode import. This test covers the same "is the command actually
 * registered/declared" intent the task asked for, at the one boundary that
 * *is* plain data: package.json's contributes block.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

// This project compiles to CommonJS (see src/adapters/hook-log-reader.ts's
// header comment) -- __dirname, not import.meta.url, is the native seam.
const pkg = JSON.parse(readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"));

describe("package.json contributes -- Knowledge Map", () => {
  it("declares both commands", () => {
    const commandIds = pkg.contributes.commands.map((c: { command: string }) => c.command);
    expect(commandIds).toContain("tourist.generateKnowledgeMap");
    expect(commandIds).toContain("tourist.showKnowledgeMap");
  });

  it("declares the tourist.knowledgeMap.* settings with the spec'd defaults", () => {
    const props = pkg.contributes.configuration.properties;
    expect(props["tourist.knowledgeMap.enabled"]).toMatchObject({ type: "boolean", default: false });
    expect(props["tourist.knowledgeMap.claudeBackend"]).toMatchObject({
      type: "string",
      enum: ["cli", "api-key"],
      default: "cli",
    });
    expect(props["tourist.knowledgeMap.claudeCliPath"]).toMatchObject({ type: "string", default: "claude" });
    expect(props["tourist.knowledgeMap.model"]).toMatchObject({ type: "string", default: "claude-sonnet-5" });
  });
});
