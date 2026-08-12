import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classifyLiveChange, classifyWholeFileDiffSpan } from "../../src/core/tier-classifier.ts";
import type { CorroborationSnapshot } from "../../src/core/corroboration-store.ts";

const NONE: CorroborationSnapshot = {
  lockFile: { active: false },
  shellIntegration: { active: false },
  processScan: { active: false },
};

function withActive(...sources: Array<keyof CorroborationSnapshot>): CorroborationSnapshot {
  const snapshot: CorroborationSnapshot = structuredClone(NONE);
  for (const s of sources) snapshot[s] = { active: true };
  return snapshot;
}

describe("classifyLiveChange", () => {
  test("hook match always wins, regardless of dirty state", () => {
    const result = classifyLiveChange({
      dirtyBefore: true,
      dirtyAfter: true,
      hookMatch: true,
      corroboration: NONE,
      suppressed: false,
    });
    assert.deepEqual(result, { origin: "ai", tier: "1" });
  });

  test("dirty before or after -> human, with no tier", () => {
    for (const [dirtyBefore, dirtyAfter] of [[true, true], [true, false], [false, true]] as const) {
      const result = classifyLiveChange({ dirtyBefore, dirtyAfter, hookMatch: false, corroboration: withActive("lockFile"), suppressed: false });
      assert.deepEqual(result, { origin: "human", tier: null });
    }
  });

  test("clean-before-and-after with lock-file corroboration -> ai/2a", () => {
    const result = classifyLiveChange({ dirtyBefore: false, dirtyAfter: false, hookMatch: false, corroboration: withActive("lockFile"), suppressed: false });
    assert.deepEqual(result, { origin: "ai", tier: "2a" });
  });

  test("lock-file AND shell-integration both active -> ai/2b (2b augments 2a)", () => {
    const result = classifyLiveChange({
      dirtyBefore: false,
      dirtyAfter: false,
      hookMatch: false,
      corroboration: withActive("lockFile", "shellIntegration"),
      suppressed: false,
    });
    assert.deepEqual(result, { origin: "ai", tier: "2b" });
  });

  test("shell-integration alone (no lock-file) -> ai/2b", () => {
    const result = classifyLiveChange({ dirtyBefore: false, dirtyAfter: false, hookMatch: false, corroboration: withActive("shellIntegration"), suppressed: false });
    assert.deepEqual(result, { origin: "ai", tier: "2b" });
  });

  test("process-scan alone -> ai/2c", () => {
    const result = classifyLiveChange({ dirtyBefore: false, dirtyAfter: false, hookMatch: false, corroboration: withActive("processScan"), suppressed: false });
    assert.deepEqual(result, { origin: "ai", tier: "2c" });
  });

  test("no corroboration at all -> external/3 (the headline differentiator)", () => {
    const result = classifyLiveChange({ dirtyBefore: false, dirtyAfter: false, hookMatch: false, corroboration: NONE, suppressed: false });
    assert.deepEqual(result, { origin: "external", tier: "3" });
  });

  test("git-op suppression forces null/null even with full corroboration", () => {
    const result = classifyLiveChange({
      dirtyBefore: false,
      dirtyAfter: false,
      hookMatch: false,
      corroboration: withActive("lockFile", "shellIntegration", "processScan"),
      suppressed: true,
    });
    assert.deepEqual(result, { origin: null, tier: null });
  });
});

describe("classifyWholeFileDiffSpan", () => {
  test("skips the dirty check entirely -- hook match still wins", () => {
    assert.deepEqual(classifyWholeFileDiffSpan({ hookMatch: true, corroboration: NONE, suppressed: false }), {
      origin: "ai",
      tier: "1",
    });
  });

  test("no hook match, no corroboration -> external/3", () => {
    assert.deepEqual(classifyWholeFileDiffSpan({ hookMatch: false, corroboration: NONE, suppressed: false }), {
      origin: "external",
      tier: "3",
    });
  });

  test("no hook match, lock-file corroboration -> ai/2a", () => {
    assert.deepEqual(
      classifyWholeFileDiffSpan({ hookMatch: false, corroboration: withActive("lockFile"), suppressed: false }),
      { origin: "ai", tier: "2a" }
    );
  });
});
