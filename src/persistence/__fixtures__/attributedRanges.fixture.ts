import type { AttributedRange } from "../types.js";

/**
 * Hand-written stand-in for Agent A's real engine output. Lives here (not
 * test/fixtures/, which is off-limits to Agent B) so persistence can be built
 * and unit-tested without waiting on src/core/.
 */
export const attributedRangesFixture: AttributedRange[] = [
  {
    id: "range-1",
    fsPath: "/repo/src/util/parse.ts",
    range: { startLine: 10, endLine: 24 },
    text: "export function parseConfig(input: string) {\n  return JSON.parse(input);\n}\n",
    attribution: {
      author: "alice@example.com",
      tier: "verified",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      note: "Extracted during config refactor"
    }
  },
  {
    id: "range-2",
    fsPath: "/repo/src/util/parse.ts",
    range: { startLine: 30, endLine: 45 },
    text: "export function stringifyConfig(config: unknown) {\n  return JSON.stringify(config, null, 2);\n}\n",
    attribution: {
      author: "bob@example.com",
      tier: "inferred",
      createdAt: 1_700_000_500_000,
      updatedAt: 1_700_100_000_000
    }
  },
  {
    id: "range-3",
    fsPath: "/repo/src/index.ts",
    range: { startLine: 1, endLine: 5 },
    text: "import { parseConfig } from './util/parse';\n\nexport { parseConfig };\n",
    attribution: {
      author: "carol@example.com",
      tier: "heuristic",
      createdAt: 1_690_000_000_000,
      updatedAt: 1_690_000_000_000
    }
  },
  {
    id: "range-4-stale",
    fsPath: "/repo/src/legacy/old.ts",
    range: { startLine: 100, endLine: 120 },
    text: "// long-untouched legacy block\nfunction legacyDoThing() {\n  return 42;\n}\n",
    attribution: {
      author: "dave@example.com",
      tier: "heuristic",
      createdAt: 1_600_000_000_000,
      updatedAt: 1_600_000_000_000
    }
  }
];
