import { describe, expect, it } from "vitest";
import { buildAnalyserArgs, looksLikeUnsupportedFlags } from "../../src/vscode-integration/knowledge-map/generate.ts";

const BASE_OPTS = {
  repoRoot: "/repo",
  forestJsonPath: "/repo/ideation/knowledge-forest/data/forest.json",
  claudeBackend: "cli" as const,
  claudeCliPath: "claude",
  model: "claude-sonnet-5",
  since: "30 days ago",
  maxCommits: 20,
  forestKinds: ["tech", "cs", "practice"],
  includePrompts: false,
};

describe("buildAnalyserArgs", () => {
  it("builds the planned flag set for a normal generate run", () => {
    const args = buildAnalyserArgs(BASE_OPTS);
    expect(args).toEqual([
      "--repo",
      "/repo",
      "--out",
      "/repo/ideation/knowledge-forest/data/forest.json",
      "--since",
      "30 days ago",
      "--max-commits",
      "20",
      "--forest",
      "tech,cs,practice",
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
      ...BASE_OPTS,
      forestJsonPath: "/repo/forest.json",
      claudeBackend: "api-key",
      deepDiveTopics: ["Django", "Async / asyncio"],
    });
    expect(args.slice(-2)).toEqual(["--deep-dive", "Django,Async / asyncio"]);
  });

  it("omits --deep-dive when the topic list is empty", () => {
    const args = buildAnalyserArgs({
      ...BASE_OPTS,
      forestJsonPath: "/repo/forest.json",
      deepDiveTopics: [],
    });
    expect(args).not.toContain("--deep-dive");
  });

  it("omits --include-prompts when includePrompts is false", () => {
    const args = buildAnalyserArgs(BASE_OPTS);
    expect(args).not.toContain("--include-prompts");
  });

  it("appends --include-prompts (with no value) when includePrompts is true", () => {
    const args = buildAnalyserArgs({ ...BASE_OPTS, includePrompts: true });
    expect(args).toContain("--include-prompts");
    // It's a bare flag, not `--include-prompts <value>` -- the next entry
    // is either another flag or the end of the array, never a stray value.
    const idx = args.indexOf("--include-prompts");
    expect(args[idx + 1]?.startsWith("--") ?? true).toBe(true);
  });

  it("threads --since, --max-commits, and --forest through from options", () => {
    const args = buildAnalyserArgs({
      ...BASE_OPTS,
      since: "2026-06-01",
      maxCommits: 5,
      forestKinds: ["tech"],
    });
    expect(args).toEqual(
      expect.arrayContaining(["--since", "2026-06-01", "--max-commits", "5", "--forest", "tech"])
    );
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
