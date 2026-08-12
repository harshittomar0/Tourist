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

  it("falls back to empty on malformed JSON instead of throwing", () => {
    saveForest(forestJsonPath, baseForest());
    writeFileSync(forestJsonPath, "{ not json", "utf8");
    expect(loadForest(forestJsonPath)).toEqual({ tech: [], cs: [], practice: [] });
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
});
