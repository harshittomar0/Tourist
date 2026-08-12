import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Reads Claude Code's own session transcripts (~/.claude/projects/<encoded-repo-path>/*.jsonl).
 * This is the richest signal for CS Fundamentals in particular (per
 * PLAN.md — code alone under-detects theoretical understanding), but it's
 * also the most privacy-sensitive source in this pipeline: it's raw
 * conversation content, not just code. Behind an explicit `--include-prompts`
 * CLI flag (opt-in, never on by default) — see PLAN.md "Privacy boundary."
 */
export interface PromptTurn {
  sessionFile: string;
  role: "user" | "assistant";
  text: string;
  ts?: string;
}

/**
 * Claude Code encodes a repo's absolute path into its project-transcript
 * directory name by replacing both "/" and "." with "-" (verified against
 * a real transcript dir, not guessed — e.g. "/Users/x/.ao/data" becomes
 * "-Users-x--ao-data", note the double dash where "/." collapses).
 */
export function projectTranscriptDir(repoPath: string, claudeHome = path.join(os.homedir(), ".claude")): string {
  const encoded = repoPath.replace(/[/.]/g, "-");
  return path.join(claudeHome, "projects", encoded);
}

export function listTranscriptFiles(repoPath: string): string[] {
  const dir = projectTranscriptDir(repoPath);
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/**
 * Extracts plain-text user/assistant turns from one transcript file.
 * Tolerant of unknown/extra fields — Claude Code's transcript schema isn't
 * a stable public contract, so this only reads the shape it needs and
 * skips anything it doesn't recognize rather than throwing.
 */
export function readTranscript(filePath: string): PromptTurn[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const turns: PromptTurn[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const turn = extractTurn(entry, filePath);
    if (turn) turns.push(turn);
  }
  return turns;
}

function extractTurn(entry: unknown, sessionFile: string): PromptTurn | null {
  if (typeof entry !== "object" || entry === null) return null;
  const e = entry as Record<string, unknown>;
  const message = e.message as Record<string, unknown> | undefined;
  const role = message?.role ?? e.role;
  if (role !== "user" && role !== "assistant") return null;

  const content = message?.content ?? e.content;
  const text = flattenContent(content);
  if (!text) return null;

  return {
    sessionFile,
    role,
    text,
    ts: typeof e.timestamp === "string" ? e.timestamp : undefined
  };
}

function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "object" && block !== null && "text" in block) {
          const t = (block as Record<string, unknown>).text;
          return typeof t === "string" ? t : "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}
