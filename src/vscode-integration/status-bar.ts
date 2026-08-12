/**
 * Status bar percentage rollup -- extends tourist-raw's two-bucket
 * `stats.ts` display to ai/human/external/total, backed by the
 * continuously-updated whole-workspace state per PLAN1.md Phase 3 (rather
 * than tourist-raw's mix of "live state for open files, saved state for
 * closed ones").
 */
import * as vscode from "vscode";
import { collectWorkspaceRollup, type CollectRollupOptions } from "./attribution-rollup.ts";
import { formatStats } from "./stats.ts";

export class StatusBarController {
  private readonly item: vscode.StatusBarItem;

  constructor(private readonly getOptions: () => CollectRollupOptions) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.name = "Tourist";
    this.item.command = "tourist.openWorkspaceView";
    this.item.tooltip = "Tourist: click to open the workspace attribution view";
  }

  async refresh(): Promise<void> {
    const { total } = await collectWorkspaceRollup(this.getOptions());
    this.item.text = `$(telescope) ${formatStats(total)}`;
    this.item.show();
  }

  hide(): void {
    this.item.hide();
  }

  dispose(): void {
    this.item.dispose();
  }
}
