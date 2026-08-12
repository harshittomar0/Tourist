/**
 * Shared fixture format for src/core/engine.ts, per PLAN1.md Phase 1's
 * "Design constraint": a sequence of synthetic change events + dirty-state
 * flags + synthetic corroboration-state snapshots, with no dependency on a
 * real `vscode.TextDocument` or editor. Consumed by both Agent A's unit
 * tests (test/core/engine.test.ts) and the Phase 4 edge-case suite, so both
 * read exactly one interpretation of a fixture -- see loader.ts.
 *
 * A fixture is pure INPUT (a scenario to replay). It intentionally carries
 * no expected-output assertions: those stay in the TS test file that loads
 * the fixture, same as the existing inline-fixture tests in
 * test/core/engine.test.ts. This keeps one fixture reusable across multiple
 * tests/assertions without the fixture and its assertions drifting apart.
 */

import type { NormalizedChangeBatch, WholeFileDiffInput } from "../../src/core/types.ts";
import type { CorroborationSource } from "../../src/core/corroboration-store.ts";

/** One entry in a fixture's ordered `steps` array. Steps are applied to a
 * fresh AttributionEngine + CorroborationStore, in array order -- order is
 * significant (it *is* the timeline being simulated), independent of the
 * `timestamp` field any individual step's payload may also carry. */
export type FixtureStep =
  | { kind: "open"; docId: string; content: string }
  | { kind: "pushChanges"; batch: NormalizedChangeBatch }
  | { kind: "ingestWholeFileDiff"; input: WholeFileDiffInput }
  | { kind: "setCorroborationSignal"; workspaceId: string; source: CorroborationSource; active: boolean; since: number; metadata?: Record<string, unknown> }
  | { kind: "clearCorroborationSignal"; workspaceId: string; source: CorroborationSource }
  | { kind: "setGitOpSuppression"; workspaceId: string; suppressed: boolean };

export interface Fixture {
  /** Short, stable identifier -- matches the JSON filename minus extension. */
  name: string;
  /** One-line human-readable description of the scenario being reproduced. */
  description: string;
  /** RESEARCH1.md / PLAN1.md cross-reference, when the fixture exists to
   * pin down a specific tier-classification branch or edge case (optional --
   * ad hoc fixtures don't need one). */
  ref?: string;
  /** `resolveWorkspaceId` for every docId this fixture opens, unless a step
   * needs a different workspace (rare enough not to warrant a per-doc map in
   * v1 -- add one if/when Phase 4 needs it). */
  workspaceId: string;
  steps: FixtureStep[];
}
