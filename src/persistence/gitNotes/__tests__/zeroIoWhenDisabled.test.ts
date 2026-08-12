import { describe, expect, it, vi } from "vitest";
import { fetchAttributionNotes, pushAttributionNotes } from "../commands.js";
import { DEFAULT_ATTRIBUTION_SHARING_CONFIG } from "../config.js";
import { handlePostCommit, handlePostRewrite } from "../rewriteContinuity.js";
import type { GitRunner } from "../types.js";

/**
 * The load-bearing guarantee for Mode B: when the toggle is off, none of the
 * public entry points touch git at all — not even a read. A spy runner that
 * throws on any invocation proves this far more strongly than asserting call
 * counts after the fact.
 */
function throwingRunner(): GitRunner {
  return vi.fn(async () => {
    throw new Error("git-notes I/O attempted while attribution sharing is disabled");
  });
}

describe("zero git-notes I/O when Mode B is disabled", () => {
  const disabledConfig = { ...DEFAULT_ATTRIBUTION_SHARING_CONFIG, enabled: false };

  it("pushAttributionNotes never calls git", async () => {
    const runner = throwingRunner();
    const result = await pushAttributionNotes(runner, "/repo", disabledConfig);
    expect(result).toEqual({ skipped: true, reason: "disabled" });
    expect(runner).not.toHaveBeenCalled();
  });

  it("fetchAttributionNotes never calls git", async () => {
    const runner = throwingRunner();
    const result = await fetchAttributionNotes(runner, "/repo", disabledConfig);
    expect(result).toEqual({ skipped: true, reason: "disabled" });
    expect(runner).not.toHaveBeenCalled();
  });

  it("handlePostCommit never calls git (and never even stats CHERRY_PICK_HEAD)", async () => {
    const runner = throwingRunner();
    const result = await handlePostCommit(runner, "/repo/does/not/exist", disabledConfig, () => {});
    expect(result).toEqual({ skipped: true });
    expect(runner).not.toHaveBeenCalled();
  });

  it("handlePostRewrite never calls git", async () => {
    const runner = throwingRunner();
    const result = await handlePostRewrite(runner, "/repo", disabledConfig, "old new\n");
    expect(result).toEqual({ skipped: true });
    expect(runner).not.toHaveBeenCalled();
  });

  it("enabling the config is what flips the behavior — sanity check the flag itself", async () => {
    const runner = throwingRunner();
    await expect(pushAttributionNotes(runner, "/repo", { enabled: true })).rejects.toThrow(
      "git-notes I/O attempted"
    );
    expect(runner).toHaveBeenCalled();
  });
});
