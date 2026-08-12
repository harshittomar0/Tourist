import { readFileSync } from "node:fs";
import path from "node:path";
import { AttributionEngine, type EngineDeps } from "../../src/core/engine.ts";
import { CorroborationStore } from "../../src/core/corroboration-store.ts";
import type { Fixture } from "./types.ts";

const SCENARIOS_DIR = path.join(__dirname, "scenarios");

/** Loads and validates a fixture by name (filename minus `.json`) from
 * test/fixtures/scenarios/. Throws on unknown fields to catch drift between
 * the fixture format and its consumers early, per the shared-format goal. */
export function loadFixture(name: string): Fixture {
  const raw = readFileSync(path.join(SCENARIOS_DIR, `${name}.json`), "utf8");
  const fixture = JSON.parse(raw) as Fixture;
  if (fixture.name !== name) {
    throw new Error(`fixture file ${name}.json has mismatched internal name ${JSON.stringify(fixture.name)}`);
  }
  return fixture;
}

export interface AppliedFixture {
  engine: AttributionEngine;
  corroborationStore: CorroborationStore;
  /** Final AttributedRange[] per docId this fixture opened or diffed, in
   * first-seen order -- the common case a test wants to assert against. */
  rangesByDocId: Map<string, ReturnType<AttributionEngine["getRanges"]>>;
}

/**
 * Replays a fixture's `steps` against a fresh engine, in order. This is the
 * ONE place that interprets the fixture format -- both Agent A's unit tests
 * and the Phase 4 edge-case suite should call this rather than
 * hand-rolling their own step interpreter, so a format change (e.g. a new
 * FixtureStep kind) only needs updating here.
 */
export function applyFixture(fixture: Fixture, engineDepsOverrides: Partial<EngineDeps> = {}): AppliedFixture {
  const corroborationStore = new CorroborationStore();
  const engine = new AttributionEngine({
    corroborationStore,
    resolveWorkspaceId: () => fixture.workspaceId,
    ...engineDepsOverrides,
  });

  const rangesByDocId = new Map<string, ReturnType<AttributionEngine["getRanges"]>>();
  const touch = (docId: string) => {
    if (!rangesByDocId.has(docId)) rangesByDocId.set(docId, []);
  };

  for (const step of fixture.steps) {
    switch (step.kind) {
      case "open":
        touch(step.docId);
        rangesByDocId.set(step.docId, engine.open(step.docId, step.content));
        break;
      case "pushChanges":
        touch(step.batch.docId);
        rangesByDocId.set(step.batch.docId, engine.pushChanges(step.batch));
        break;
      case "ingestWholeFileDiff":
        touch(step.input.docId);
        rangesByDocId.set(step.input.docId, engine.ingestWholeFileDiff(step.input));
        break;
      case "setCorroborationSignal":
        corroborationStore.setSignal(step.workspaceId, {
          source: step.source,
          active: step.active,
          since: step.since,
          metadata: step.metadata,
        });
        break;
      case "clearCorroborationSignal":
        corroborationStore.clearSignal(step.workspaceId, step.source);
        break;
      case "setGitOpSuppression":
        engine.setGitOpSuppression(step.workspaceId, step.suppressed);
        break;
      default: {
        const exhaustive: never = step;
        throw new Error(`unhandled fixture step kind: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  // Re-read final state for every touched doc via getRanges (rather than
  // trusting the last per-step return value) so callers get a consistent
  // post-replay snapshot regardless of which step happened to touch a doc
  // last.
  for (const docId of rangesByDocId.keys()) {
    rangesByDocId.set(docId, engine.getRanges(docId));
  }

  return { engine, corroborationStore, rangesByDocId };
}
