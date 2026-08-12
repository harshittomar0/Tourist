/**
 * Pure offset-range -> line-number bucketing, factored out of decorations.ts
 * so it's unit-testable without the real `vscode` module resolvable (that
 * module only exists inside the extension host; a plain test runner like
 * vitest can't import it). Decorations.ts imports `vscode` only for the
 * `createTextEditorDecorationType`/`setDecorations` glue; this file has no
 * `vscode` dependency at all, by design.
 */
import type { AttributedRange, Origin } from "./contracts.ts";

/** Structural subset of `vscode.TextDocument` this module needs. */
export interface OffsetToLine {
  positionAt(offset: number): { line: number };
}

export interface LineBuckets {
  ai: Set<number>;
  human: Set<number>;
  external: Set<number>;
}

export function computeLineBuckets(doc: OffsetToLine, ranges: readonly AttributedRange[]): LineBuckets {
  const buckets: LineBuckets = { ai: new Set(), human: new Set(), external: new Set() };
  for (const range of ranges) {
    if (range.origin === null || range.endOffset <= range.startOffset) continue;
    const startLine = doc.positionAt(range.startOffset).line;
    const endLine = doc.positionAt(range.endOffset - 1).line;
    const bucket = buckets[range.origin];
    for (let line = startLine; line <= endLine; line++) bucket.add(line);
  }
  return buckets;
}

export type BucketableOrigin = Exclude<Origin, null>;
