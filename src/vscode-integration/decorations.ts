/**
 * Three-way gutter/border decorations -- extends tourist-raw's
 * `src/attribution/decorations.ts` (blue "ai" / orange "human" left-border
 * pair) with a genuinely distinct third treatment for "external/unknown"
 * (Tier 3), per PLAN1.md Phase 3: "so it's visibly distinct from both 'ai'
 * and 'human' rather than silently merged into one of them."
 *
 * The third treatment is deliberately not just "a third color" on the same
 * solid-left-border shape: a dashed border (a shape difference, not only a
 * hue difference, so it stays distinguishable for colorblind users) plus a
 * small gutter glyph, since "external/unknown" is this project's headline
 * differentiator from tourist-raw and a same-shape-different-hue treatment
 * risks reading as a minor variant rather than a genuinely new bucket.
 */
import * as vscode from "vscode";
import type { AttributedRange, Origin } from "./contracts.ts";
import { computeLineBuckets } from "./line-buckets.ts";

const externalGutterIcon = vscode.Uri.parse(
  "data:image/svg+xml;base64," +
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">' +
        '<circle cx="8" cy="8" r="6.5" fill="none" stroke="#c026d3" stroke-width="1.5"/>' +
        '<text x="8" y="11.5" font-size="9" text-anchor="middle" fill="#c026d3" font-family="sans-serif">?</text>' +
        "</svg>"
    ).toString("base64")
);

export const aiDecoration = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  borderWidth: "0 0 0 2px",
  borderStyle: "solid",
  borderColor: "#3b82f6",
  overviewRulerColor: "#3b82f6",
  overviewRulerLane: vscode.OverviewRulerLane.Left,
});

export const humanDecoration = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  borderWidth: "0 0 0 2px",
  borderStyle: "solid",
  borderColor: "#f0883e",
  overviewRulerColor: "#f0883e",
  overviewRulerLane: vscode.OverviewRulerLane.Left,
});

export const externalDecoration = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  borderWidth: "0 0 0 2px",
  borderStyle: "dashed",
  borderColor: "#c026d3",
  overviewRulerColor: "#c026d3",
  overviewRulerLane: vscode.OverviewRulerLane.Left,
  gutterIconPath: externalGutterIcon,
  gutterIconSize: "contain",
});

const HOVER: Record<Exclude<Origin, null>, string> = {
  ai: "Tourist: written by Claude Code",
  human: "Tourist: written by you",
  external: "Tourist: written by something else (formatter, another tool, a disk write with no corroborating signal)",
};

export function refreshDecorations(editor: vscode.TextEditor, ranges: readonly AttributedRange[], showMarkers: boolean): void {
  if (!showMarkers) {
    editor.setDecorations(aiDecoration, []);
    editor.setDecorations(humanDecoration, []);
    editor.setDecorations(externalDecoration, []);
    return;
  }

  const buckets = computeLineBuckets(editor.document, ranges);
  const toOptions = (lines: Set<number>, origin: Exclude<Origin, null>): vscode.DecorationOptions[] => {
    const options: vscode.DecorationOptions[] = [];
    for (const lineNo of lines) {
      if (lineNo >= editor.document.lineCount) continue;
      const line = editor.document.lineAt(lineNo);
      if (line.isEmptyOrWhitespace) continue; // blank lines carry no real authorship to show
      options.push({ range: line.range, hoverMessage: HOVER[origin] });
    }
    return options;
  };

  editor.setDecorations(aiDecoration, toOptions(buckets.ai, "ai"));
  editor.setDecorations(humanDecoration, toOptions(buckets.human, "human"));
  editor.setDecorations(externalDecoration, toOptions(buckets.external, "external"));
}
