import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyOverride, loadForest, saveForest, type MergeForestFn } from "../../src/vscode-integration/knowledge-map/store.ts";
import type { ForestFile, NodeOverrideMessage } from "../../src/vscode-integration/knowledge-map/types.ts";

let dir: string;
let forestJsonPath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "knowledge-map-store-"));
  forestJsonPath = path.join(dir, "data", "forest.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function baseForest(): ForestFile {
  return {
    tech: [
      {
        label: "Backend — Python",
        provenance: "confirmed",
        proficiency: 4,
        children: [{ label: "Django", provenance: "ai", proficiency: 2, children: [], latent: [] }],
        latent: [],
      },
    ],
    cs: [],
    practice: [],
  };
}

describe("loadForest/saveForest", () => {
  it("returns an empty forest when the file doesn't exist yet", () => {
    expect(loadForest(forestJsonPath)).toEqual({ tech: [], cs: [], practice: [] });
  });

  it("round-trips through disk", () => {
    const forest = baseForest();
    saveForest(forestJsonPath, forest);
    expect(loadForest(forestJsonPath)).toEqual(forest);
  });

  it("throws on malformed JSON instead of silently returning empty (regression: corruption must be visible, not indistinguishable from a first run)", () => {
    saveForest(forestJsonPath, baseForest());
    writeFileSync(forestJsonPath, "{ not json", "utf8");
    expect(() => loadForest(forestJsonPath)).toThrow(/not valid JSON/);
  });

  it("still returns an empty forest when the containing directory doesn't exist yet either", () => {
    expect(loadForest(path.join(dir, "does", "not", "exist", "forest.json"))).toEqual({ tech: [], cs: [], practice: [] });
  });
});

describe("applyOverride", () => {
  it("confirms an ai node directly when no merge function is available (analyser not built)", () => {
    const forest = baseForest();
    const msg: NodeOverrideMessage = {
      type: "nodeOverride",
      forest: "tech",
      path: ["Backend — Python", "Django"],
      action: "confirm",
      value: 3,
    };
    const result = applyOverride(forest, msg, undefined);
    expect(result.changed).toBe(true);
    expect(result.usedMerge).toBe(false);
    const django = result.forest.tech[0].children[0];
    expect(django.provenance).toBe("confirmed");
    expect(django.proficiency).toBe(3);
  });

  it("routes the ai -> confirmed transition through mergeForest when it's available", () => {
    const forest = baseForest();
    let receivedIncoming: ForestFile | undefined;
    const fakeMerge: MergeForestFn = (existing, incoming) => {
      receivedIncoming = incoming;
      // Minimal real-ish merge behavior for the assertion below.
      return existing;
    };
    const msg: NodeOverrideMessage = {
      type: "nodeOverride",
      forest: "tech",
      path: ["Backend — Python", "Django"],
      action: "confirm",
      value: 3,
    };
    const result = applyOverride(forest, msg, fakeMerge);
    expect(result.usedMerge).toBe(true);
    expect(receivedIncoming?.tech[0].label).toBe("Backend — Python");
    expect(receivedIncoming?.tech[0].children[0]).toMatchObject({ label: "Django", provenance: "confirmed", proficiency: 3 });
  });

  it("does not route an already-confirmed/gap node's re-edit through mergeForest (direct mutation instead)", () => {
    const forest = baseForest();
    let mergeCalled = false;
    const fakeMerge: MergeForestFn = (existing) => {
      mergeCalled = true;
      return existing;
    };
    const msg: NodeOverrideMessage = {
      type: "nodeOverride",
      forest: "tech",
      path: ["Backend — Python"],
      action: "proficiency",
      value: 5,
    };
    const result = applyOverride(forest, msg, fakeMerge);
    expect(mergeCalled).toBe(false);
    expect(result.usedMerge).toBe(false);
    expect(result.forest.tech[0].proficiency).toBe(5);
    expect(result.forest.tech[0].provenance).toBe("confirmed");
  });

  it("rejects a node, setting provenance gap and proficiency 0", () => {
    const forest = baseForest();
    const msg: NodeOverrideMessage = { type: "nodeOverride", forest: "tech", path: ["Backend — Python", "Django"], action: "reject" };
    const result = applyOverride(forest, msg, undefined);
    const django = result.forest.tech[0].children[0];
    expect(django.provenance).toBe("gap");
    expect(django.proficiency).toBe(0);
  });

  it("renames a node", () => {
    const forest = baseForest();
    const msg: NodeOverrideMessage = {
      type: "nodeOverride",
      forest: "tech",
      path: ["Backend — Python", "Django"],
      action: "rename",
      value: "Django (renamed)",
    };
    const result = applyOverride(forest, msg, undefined);
    expect(result.forest.tech[0].children[0].label).toBe("Django (renamed)");
  });

  it("adds a child under a parent path", () => {
    const forest = baseForest();
    const msg: NodeOverrideMessage = {
      type: "nodeOverride",
      forest: "tech",
      path: ["Backend — Python"],
      action: "addChild",
      value: "Celery",
    };
    const result = applyOverride(forest, msg, undefined);
    expect(result.forest.tech[0].children.map((n) => n.label)).toEqual(["Django", "Celery"]);
  });

  it("adds a new root stack when path is empty", () => {
    const forest = baseForest();
    const msg: NodeOverrideMessage = { type: "nodeOverride", forest: "tech", path: [], action: "addChild", value: "Infra — Terraform" };
    const result = applyOverride(forest, msg, undefined);
    expect(result.forest.tech.map((n) => n.label)).toEqual(["Backend — Python", "Infra — Terraform"]);
  });

  it("deletes a node by path", () => {
    const forest = baseForest();
    const msg: NodeOverrideMessage = { type: "nodeOverride", forest: "tech", path: ["Backend — Python", "Django"], action: "delete" };
    const result = applyOverride(forest, msg, undefined);
    expect(result.forest.tech[0].children).toEqual([]);
  });

  it("no-ops (changed: false) for an unresolvable path", () => {
    const forest = baseForest();
    const msg: NodeOverrideMessage = { type: "nodeOverride", forest: "tech", path: ["Nonexistent"], action: "reject" };
    const result = applyOverride(forest, msg, undefined);
    expect(result.changed).toBe(false);
  });

  // Regression: findByPath/mergeNodeList/containsChain all identify a node
  // by label alone, with no uniqueness guarantee -- so if addChild ever let
  // a duplicate sibling label through, every later confirm/reject/rename/
  // delete/deep-dive on either of the two same-labeled nodes would silently
  // act on whichever one `.find()` happens to hit first.
  it("rejects addChild when a sibling with the same label already exists under the parent", () => {
    const forest = baseForest();
    const msg: NodeOverrideMessage = {
      type: "nodeOverride",
      forest: "tech",
      path: ["Backend — Python"],
      action: "addChild",
      value: "Django", // already exists as a sibling under Backend — Python
    };
    const result = applyOverride(forest, msg, undefined);
    expect(result.changed).toBe(false);
    expect(result.error).toMatch(/already exists/);
    expect(result.forest.tech[0].children).toHaveLength(1); // no duplicate was added
  });

  it("rejects addChild when a duplicate would land at the top level", () => {
    const forest = baseForest();
    const msg: NodeOverrideMessage = {
      type: "nodeOverride",
      forest: "tech",
      path: [],
      action: "addChild",
      value: "Backend — Python", // already exists as a root
    };
    const result = applyOverride(forest, msg, undefined);
    expect(result.changed).toBe(false);
    expect(result.error).toMatch(/already exists/);
    expect(result.forest.tech).toHaveLength(1);
  });

  it("still allows addChild for a genuinely new label alongside an existing sibling", () => {
    const forest = baseForest();
    const msg: NodeOverrideMessage = {
      type: "nodeOverride",
      forest: "tech",
      path: ["Backend — Python"],
      action: "addChild",
      value: "Celery",
    };
    const result = applyOverride(forest, msg, undefined);
    expect(result.changed).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.forest.tech[0].children.map((n) => n.label)).toEqual(["Django", "Celery"]);
  });

  it("rejects rename when the new label collides with an existing sibling", () => {
    const forest = baseForest();
    forest.tech[0].children.push({ label: "Flask", provenance: "ai", proficiency: 1, children: [], latent: [] });
    const msg: NodeOverrideMessage = {
      type: "nodeOverride",
      forest: "tech",
      path: ["Backend — Python", "Django"],
      action: "rename",
      value: "Flask", // collides with the sibling just added
    };
    const result = applyOverride(forest, msg, undefined);
    expect(result.changed).toBe(false);
    expect(result.error).toMatch(/already exists/);
    // Neither node was silently merged/renamed away.
    expect(result.forest.tech[0].children.map((n) => n.label)).toEqual(["Django", "Flask"]);
  });

  it("allows renaming a node to its own current label as a no-op (not a false collision)", () => {
    const forest = baseForest();
    const msg: NodeOverrideMessage = {
      type: "nodeOverride",
      forest: "tech",
      path: ["Backend — Python", "Django"],
      action: "rename",
      value: "Django",
    };
    const result = applyOverride(forest, msg, undefined);
    expect(result.changed).toBe(false);
    expect(result.error).toBeUndefined();
  });
});
