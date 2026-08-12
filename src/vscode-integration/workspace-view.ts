/**
 * NEW (per PLAN1.md Phase 3's "always-on, workspace-wide tracking" bullet):
 * a workspace-level attribution view/panel. Tracking is no longer gated on
 * an open editor tab, so this is the surface that shows ai/human/external
 * rollups for files that were never opened this session -- something
 * tourist-raw's model (live tracker + per-file webview report) never
 * needed, since tourist-raw's tracker had nothing to say about a file it
 * never saw opened.
 *
 * Implemented as a `TreeView` (contributed under `explorer` in
 * package.json) rather than a webview: the data is inherently hierarchical
 * (workspace folder -> file -> stats) and needs no custom rendering beyond
 * a label and a percentage string, so a webview would just be
 * reimplementing tree-item rendering by hand for no benefit.
 */
import * as vscode from "vscode";
import { collectWorkspaceRollup, type CollectRollupOptions, type FileRollup, type FolderScope } from "./attribution-rollup.ts";
import { addStats, EMPTY_STATS, formatStats, type AttributionStats } from "./stats.ts";

export type RollupNode =
  | { kind: "folder"; folder: FolderScope; label: string; stats: AttributionStats; files: FileRollup[] }
  | { kind: "file"; label: string; docId: string; stats: AttributionStats };

export class WorkspaceAttributionProvider implements vscode.TreeDataProvider<RollupNode> {
  private readonly emitter = new vscode.EventEmitter<RollupNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private folderNodes: RollupNode[] = [];

  constructor(private readonly getOptions: () => CollectRollupOptions) {}

  async refresh(): Promise<void> {
    const rollup = await collectWorkspaceRollup(this.getOptions());
    const byFolder = new Map<FolderScope, FileRollup[]>();
    for (const folder of this.getOptions().folders) byFolder.set(folder, []);

    for (const file of rollup.files) {
      const folder = [...byFolder.keys()].find((f) => withinFolder(file.docId, f.path)) ?? [...byFolder.keys()][0];
      if (!folder) continue;
      byFolder.get(folder)!.push(file);
    }

    this.folderNodes = [...byFolder.entries()].map(([folder, files]) => {
      const stats = files.reduce((acc, f) => addStats(acc, f.stats), EMPTY_STATS);
      return { kind: "folder" as const, folder, label: labelForFolder(folder.path), stats, files };
    });
    this.emitter.fire(undefined);
  }

  getTreeItem(element: RollupNode): vscode.TreeItem {
    if (element.kind === "folder") {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);
      item.description = formatStats(element.stats);
      item.contextValue = "tourist.folder";
      return item;
    }
    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    item.description = formatStats(element.stats);
    item.resourceUri = vscode.Uri.file(element.docId);
    item.command = {
      command: "vscode.open",
      title: "Open",
      arguments: [vscode.Uri.file(element.docId)],
    };
    item.contextValue = "tourist.file";
    return item;
  }

  getChildren(element?: RollupNode): RollupNode[] {
    if (!element) return this.folderNodes;
    if (element.kind !== "folder") return [];
    return element.files
      .slice()
      .sort((a, b) => b.stats.total - a.stats.total)
      .map((f) => ({ kind: "file" as const, label: labelForFile(f.docId, element.folder.path), docId: f.docId, stats: f.stats }));
  }
}

function withinFolder(docId: string, folderPath: string): boolean {
  return docId === folderPath || docId.startsWith(folderPath.endsWith("/") ? folderPath : `${folderPath}/`);
}

function labelForFolder(folderPath: string): string {
  const parts = folderPath.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? folderPath;
}

function labelForFile(docId: string, folderPath: string): string {
  const prefix = folderPath.endsWith("/") ? folderPath : `${folderPath}/`;
  return docId.startsWith(prefix) ? docId.slice(prefix.length) : docId;
}
