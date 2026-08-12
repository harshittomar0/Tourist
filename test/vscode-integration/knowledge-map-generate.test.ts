import { describe, expect, it } from "vitest";
import { buildAnalyserArgs, looksLikeUnsupportedFlags } from "../../src/vscode-integration/knowledge-map/generate.ts";

describe("buildAnalyserArgs", () => {
  it("builds the planned flag set for a normal generate run", () => {
    const args = buildAnalyserArgs({
      repoRoot: "/repo",
      forestJsonPath: "/repo/ideation/knowledge-forest/data/forest.json",
      claudeBackend: "cli",
      claudeCliPath: "claude",
      model: "claude-sonnet-5",
    });
    expect(args).toEqual([
      "--repo",
      "/repo",
      "--forest",
      "/repo/ideation/knowledge-forest/data/forest.json",
      "--claude-backend",
      "cli",
      "--claude-cli-path",
      "claude",
      "--model",
      "claude-sonnet-5",
    ]);
  });

  it("appends --deep-dive with a comma-joined topic list only when topics are given", () => {
    const args = buildAnalyserArgs({
      repoRoot: "/repo",
      forestJsonPath: "/repo/forest.json",
      claudeBackend: "api-key",
      claudeCliPath: "claude",
      model: "claude-sonnet-5",
      deepDiveTopics: ["Django", "Async / asyncio"],
    });
    expect(args.slice(-2)).toEqual(["--deep-dive", "Django,Async / asyncio"]);
  });

  it("omits --deep-dive when the topic list is empty", () => {
    const args = buildAnalyserArgs({
      repoRoot: "/repo",
      forestJsonPath: "/repo/forest.json",
      claudeBackend: "cli",
      claudeCliPath: "claude",
      model: "claude-sonnet-5",
      deepDiveTopics: [],
    });
    expect(args).not.toContain("--deep-dive");
  });
});

describe("looksLikeUnsupportedFlags", () => {
  it("detects cli.ts's own 'Unknown argument' rejection message", () => {
    expect(looksLikeUnsupportedFlags("Unknown argument: --claude-backend\n")).toBe(true);
  });

  it("does not misclassify an unrelated failure", () => {
    expect(looksLikeUnsupportedFlags("ANTHROPIC_API_KEY is not set.")).toBe(false);
  });
});
