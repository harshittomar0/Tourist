#!/usr/bin/env node
// Claude Code hook for Tourist v2's line attribution engine. Registered for
// BOTH PreToolUse and PostToolUse on Edit/Write/MultiEdit (mandatory setup
// per GOAL1.md §2, unlike tourist-raw's optional hook install):
//
//   - PreToolUse  snapshots the file's content *before* Claude edits it.
//   - PostToolUse diffs that snapshot against the new content and records
//     only the lines that actually CHANGED as Tier-1 ground truth.
//
// Diffing (rather than marking everything Claude wrote) is what prevents the
// "Claude rewrote the whole file, so every line is now AI" false positive.
//
// Adapted directly from tourist-raw/hooks/tourist-hook.mjs -- the diffing
// algorithm is unchanged (still the same LCS line diff with the same
// pathological-size guard, ported verbatim into src/core/line-diff.ts's
// computeLineDiffHunks() for the extension's own whole-file-diff path, so
// the two implementations stay conceptually identical even though they
// serve different consumers). What changed: the on-disk log location
// (namespaced under ~/.claude/tourist-attribution/ instead of
// ~/.claude/tourist/, so this hook and tourist-raw's own hook -- if both
// happen to be installed -- never clobber each other's log), and the log
// schema drops tourist-raw's `snippet` field (this project has no
// prompt-scoring feature to ground, so there's nothing that consumes it).
//
// TODO(Phase 0 experiment 4): confirm this hook still fires for
// Edit/Write/MultiEdit on the current Claude Code CLI version, in both a
// bare terminal and the VS Code extension's terminal, and specifically
// under `--worktree` -- see src/adapters/hook-log-reader.ts's own TODO.
//
// This hook only records data as a side effect: it writes nothing to
// stdout and always exits 0, so it can never block or disturb Claude Code.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";

const CONFIG_BASE = process.env.CLAUDE_CONFIG_DIR
  ? process.env.CLAUDE_CONFIG_DIR
  : path.join(os.homedir(), ".claude");
const ATTRIBUTION_DIR = path.join(CONFIG_BASE, "tourist-attribution");
const PRE_DIR = path.join(ATTRIBUTION_DIR, "pre");
const LOG_FILE = path.join(ATTRIBUTION_DIR, "ai-edits.jsonl");
const MAX_RECORDS = 5000;

function sha1(text) {
  return crypto.createHash("sha1").update(text).digest("hex");
}

function snapshotPath(absFile) {
  return path.join(PRE_DIR, sha1(absFile));
}

function readFileOrEmpty(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/**
 * 0-based indices of lines in `newText` that are added or changed relative to
 * `oldText`, via a longest-common-subsequence line diff. Lines that align
 * with an identical line in `oldText` are treated as unchanged.
 */
function changedLines(oldText, newText) {
  const a = oldText.length ? oldText.split("\n") : [];
  const b = newText.length ? newText.split("\n") : [];
  const m = a.length;
  const n = b.length;
  if (n === 0) return [];
  if (m === 0) return b.map((_, i) => i); // brand-new file: all lines are AI

  // Guard against pathological O(m*n) blowups on very large files.
  if (m * n > 4_000_000) {
    const oldSet = new Set(a);
    const changed = [];
    for (let j = 0; j < n; j++) if (!oldSet.has(b[j])) changed.push(j);
    return changed;
  }

  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const changed = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      changed.push(j);
      j++;
    }
  }
  while (j < n) changed.push(j++);
  return changed;
}

/** Coalesce sorted line indices into inclusive {start,end} ranges. */
function toRanges(indices) {
  const ranges = [];
  for (const idx of indices) {
    const last = ranges[ranges.length - 1];
    if (last && idx === last.end + 1) last.end = idx;
    else ranges.push({ start: idx, end: idx });
  }
  return ranges;
}

function appendRecord(record) {
  fs.mkdirSync(ATTRIBUTION_DIR, { recursive: true });
  let lines = [];
  try {
    lines = fs.readFileSync(LOG_FILE, "utf8").split("\n").filter((l) => l.trim());
  } catch {
    // no log yet
  }
  lines.push(JSON.stringify(record));
  if (lines.length > MAX_RECORDS) lines = lines.slice(-MAX_RECORDS);
  fs.writeFileSync(LOG_FILE, lines.join("\n") + "\n", "utf8");
}

function resolveFile(payload) {
  const toolInput = payload.tool_input ?? {};
  let file = toolInput.file_path;
  if (!file) return null;
  if (!path.isAbsolute(file)) file = path.resolve(payload.cwd ?? process.cwd(), file);
  return file;
}

function main() {
  const payload = JSON.parse(fs.readFileSync(0, "utf8"));

  const toolName = payload.tool_name;
  if (!["Edit", "Write", "MultiEdit"].includes(toolName)) return;

  const file = resolveFile(payload);
  if (!file) return;

  // PreToolUse: stash the pre-edit content so PostToolUse can diff against it.
  if (payload.hook_event_name === "PreToolUse") {
    fs.mkdirSync(PRE_DIR, { recursive: true });
    fs.writeFileSync(snapshotPath(file), readFileOrEmpty(file), "utf8");
    return;
  }

  // PostToolUse (or any non-Pre event): diff old vs new, record changed lines.
  const newContent = readFileOrEmpty(file);
  const snap = snapshotPath(file);
  const oldContent = readFileOrEmpty(snap); // "" if Pre didn't run -- falls back to marking all
  try {
    fs.rmSync(snap, { force: true });
  } catch {
    // ignore
  }

  const aiRanges = toRanges(changedLines(oldContent, newContent));
  if (aiRanges.length === 0) return;

  appendRecord({
    ts: Date.now(),
    cwd: payload.cwd ?? process.cwd(),
    file,
    tool: toolName,
    contentHash: sha1(newContent),
    aiRanges,
  });
}

try {
  main();
} catch {
  // Never disturb Claude Code -- swallow everything.
}
process.exit(0);
