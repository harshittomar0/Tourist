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
    expect(props["tourist.knowledgeMap.since"]).toMatchObject({ type: "string", default: "30 days ago" });
    expect(props["tourist.knowledgeMap.maxCommits"]).toMatchObject({ type: "number", default: 20 });
    expect(props["tourist.knowledgeMap.forestKinds"]).toMatchObject({
      type: "array",
      default: ["tech", "cs", "practice"],
    });
    expect(props["tourist.knowledgeMap.forestKinds"].items).toMatchObject({
      enum: ["tech", "cs", "practice"],
    });
  });

  it("declares tourist.knowledgeMap.includePrompts as opt-in and off by default", () => {
    const props = pkg.contributes.configuration.properties;
    expect(props["tourist.knowledgeMap.includePrompts"]).toMatchObject({ type: "boolean", default: false });
    // The whole point of this setting is that it's more sensitive than
    // plain git history -- the description must say so, not bury it in
    // generic wording (see commands.ts's dedicated consent dialog).
    expect(props["tourist.knowledgeMap.includePrompts"].description).toMatch(/session transcripts|prompts/i);
    expect(props["tourist.knowledgeMap.includePrompts"].description).toMatch(/sensitive/i);
  });
});
