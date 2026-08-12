import { createHash } from "node:crypto";
import type { AttributedRange, PersistedEntry } from "./types.js";

/**
 * Normalizes text before hashing so trailing-whitespace-only edits and CRLF/LF
 * differences don't spuriously orphan an otherwise-unchanged range.
 */
export function normalizeForHash(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "");
}

export function contentHashOf(text: string): string {
  return createHash("sha256").update(normalizeForHash(text), "utf8").digest("hex");
}

export function toPersistedEntry(range: AttributedRange): PersistedEntry {
  return {
    id: range.id,
    contentHash: contentHashOf(range.text),
    lastSeenFsPath: range.fsPath,
    range: range.range,
    attribution: range.attribution
  };
}
