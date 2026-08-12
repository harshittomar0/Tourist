import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

/**
 * Reads the same on-disk log tourist's own hook writes
 * (hooks/attribution-hook.mjs) — one JSON record per Edit/Write/MultiEdit
 * Claude Code made, with the 0-based post-edit line ranges that changed.
 * We reuse this log purely as a read-only evidence source; we never write
 * to it.
 */
export interface AttributionRecord {
  ts: number;
  cwd: string;
  file: string;
  tool: "Edit" | "Write" | "MultiEdit";
  contentHash: string;
  aiRanges: Array<{ start: number; end: number }>;
}

export function attributionLogPath(configDir = process.env.CLAUDE_CONFIG_DIR): string {
  const base = configDir && configDir.length > 0 ? configDir : path.join(os.homedir(), ".claude");
  return path.join(base, "tourist-attribution", "ai-edits.jsonl");
}

export function loadAttributionLog(configDir?: string): AttributionRecord[] {
  const logFile = attributionLogPath(configDir);
  let raw: string;
  try {
    raw = fs.readFileSync(logFile, "utf8");
  } catch {
    return [];
  }
  const records: AttributionRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (isAttributionRecord(parsed)) records.push(parsed);
    } catch {
      // skip a malformed line rather than aborting the whole log read
    }
  }
  return records;
}

function isAttributionRecord(value: unknown): value is AttributionRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.ts === "number" &&
    typeof v.cwd === "string" &&
    typeof v.file === "string" &&
    typeof v.tool === "string" &&
    typeof v.contentHash === "string" &&
    Array.isArray(v.aiRanges)
  );
}

export function sha1(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex");
}

/**
 * Finds the attribution record for an exact snapshot of `file`'s content —
 * i.e. content whose sha1 matches a hook-recorded contentHash for that file.
 * This is how we correlate a git blob at a specific commit back to "was
 * this snapshot (partially) AI-authored, and which lines."
 */
export function findRecordForContent(
  records: AttributionRecord[],
  absFilePath: string,
  content: string
): AttributionRecord | undefined {
  const hash = sha1(content);
  return records.find((r) => r.file === absFilePath && r.contentHash === hash);
}

/** True if the given 0-based line index falls inside any of the record's AI ranges. */
export function isLineAiAuthored(record: AttributionRecord, lineIndex0Based: number): boolean {
  return record.aiRanges.some((r) => lineIndex0Based >= r.start && lineIndex0Based <= r.end);
}

/**
 * Splits a file's lines into human-authored vs AI-authored, using the most
 * recent matching attribution record for that exact content snapshot. If no
 * record matches (the file was never edited by Claude Code under a hooked
 * session, or predates the log's retention window), everything is treated
 * as unknown-provenance and returned as "human" by default — absence of a
 * record is not evidence of either origin, but for this analyser's purposes
 * (crediting the person, not Claude) the conservative choice is to fall
 * back to counting it as human-attributable evidence rather than silently
 * discarding it.
 */
export function partitionLinesByAuthor(
  records: AttributionRecord[],
  absFilePath: string,
  content: string
): { humanLines: string[]; aiLines: string[]; matched: boolean } {
  const lines = content.length ? content.split("\n") : [];
  const record = findRecordForContent(records, absFilePath, content);
  if (!record) {
    return { humanLines: lines, aiLines: [], matched: false };
  }
  const humanLines: string[] = [];
  const aiLines: string[] = [];
  lines.forEach((line, idx) => {
    (isLineAiAuthored(record, idx) ? aiLines : humanLines).push(line);
  });
  return { humanLines, aiLines, matched: true };
}
