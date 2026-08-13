#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { getCommitDiff, listRecentCommits, repoRoot } from "./sources/gitSource.js";
import { loadAttributionLog, partitionLinesByAuthor, attributionLogPath } from "./sources/attributionSource.js";
import { getFileContentAtCommit } from "./sources/gitSource.js";
import { listTranscriptFiles, readTranscript } from "./sources/promptSource.js";
import { buildSystemPrompt, buildUserContent, truncateEvidence, type EvidenceItem } from "./claude/buildPrompt.js";
import { createClaudeCaller, DEFAULT_CLI_PATH, DEFAULT_MODEL, type ClaudeBackend } from "./claude/client.js";
import { parseForestResponse } from "./forest/validate.js";
import { mergeForest } from "./forest/merge.js";
import { resolveDeepDiveTopics } from "./forest/deepDive.js";
import type { ForestFile, ForestKind } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface CliOptions {
  repo: string;
  since: string;
  out: string;
  forests: ForestKind[];
  includePrompts: boolean;
  dryRun: boolean;
  maxCommits: number;
  maxChars: number;
  model: string;
  claudeBackend: ClaudeBackend;
  claudeCliPath: string;
  /** Raw --deep-dive entries (comma-separated labels/paths), not yet resolved against the existing forest. */
  deepDiveLabels: string[];
  /** Raw --reopen entries (comma-separated labels/paths), not yet resolved against the existing forest.
   * See forest/merge.ts's ReopenTarget doc comment: a one-time, this-call-only exception that lets a
   * confirmed/gap node's proficiency/evidence update from this run's guess, without permanently
   * changing its provenance. */
  reopenLabels: string[];
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    repo: process.cwd(),
    since: "30 days ago",
    out: path.join(__dirname, "..", "..", "data", "forest.json"),
    forests: ["tech", "cs", "practice"],
    includePrompts: false,
    dryRun: false,
    maxCommits: 20,
    maxChars: 60_000,
    model: DEFAULT_MODEL,
    claudeBackend: "cli",
    claudeCliPath: DEFAULT_CLI_PATH,
    deepDiveLabels: [],
    reopenLabels: []
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case "--repo":
        opts.repo = path.resolve(next());
        break;
      case "--since":
        opts.since = next();
        break;
      case "--out":
        opts.out = path.resolve(next());
        break;
      case "--forest":
        opts.forests = next().split(",").filter(isForestKind);
        break;
      case "--include-prompts":
        opts.includePrompts = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--max-commits":
        opts.maxCommits = Number(next());
        break;
      case "--max-chars":
        opts.maxChars = Number(next());
        break;
      case "--model":
        opts.model = next();
        break;
      case "--claude-backend": {
        const value = next();
        if (value !== "cli" && value !== "api-key") {
          console.error(`Invalid --claude-backend: "${value}" (expected "cli" or "api-key")`);
          process.exit(1);
        }
        opts.claudeBackend = value;
        break;
      }
      case "--claude-cli-path":
        opts.claudeCliPath = next();
        break;
      case "--deep-dive":
        opts.deepDiveLabels = next()
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        break;
      case "--reopen":
        opts.reopenLabels = next()
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        process.exit(1);
    }
  }
  return opts;
}

function isForestKind(s: string): s is ForestKind {
  return s === "tech" || s === "cs" || s === "practice";
}

function loadExistingForest(outPath: string): ForestFile {
  try {
    const raw = fs.readFileSync(outPath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      tech: Array.isArray(parsed.tech) ? parsed.tech : [],
      cs: Array.isArray(parsed.cs) ? parsed.cs : [],
      practice: Array.isArray(parsed.practice) ? parsed.practice : []
    };
  } catch {
    return { tech: [], cs: [], practice: [] };
  }
}

function gatherGitEvidence(repo: string, since: string, maxCommits: number): EvidenceItem[] {
  const attributionRecords = loadAttributionLog();
  const commits = listRecentCommits(repo, since).slice(0, maxCommits);
  const items: EvidenceItem[] = [];

  for (const commit of commits) {
    const diff = getCommitDiff(repo, commit.sha);
    if (!diff.trim()) continue;

    const attributionNotes: string[] = [];
    for (const file of commit.files) {
      const absPath = path.join(repo, file);
      const content = getFileContentAtCommit(repo, commit.sha, file);
      if (!content) continue;
      const partition = partitionLinesByAuthor(attributionRecords, absPath, content);
      if (partition.matched && partition.aiLines.length > 0) {
        attributionNotes.push(
          `${file}: ${partition.aiLines.length} of ${partition.aiLines.length + partition.humanLines.length} lines were Claude-Code-authored per tourist's attribution log — weight this file's evidence down accordingly, don't credit the person for those specific lines.`
        );
      }
    }

    items.push({
      source: "git",
      ref: commit.sha.slice(0, 12),
      detail: [
        `Commit ${commit.sha.slice(0, 12)} — "${commit.message}" — files: ${commit.files.join(", ")}`,
        ...attributionNotes
      ].join("\n"),
      content: diff
    });
  }
  return items;
}

function gatherPromptEvidence(repo: string): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  for (const file of listTranscriptFiles(repo)) {
    const turns = readTranscript(file).filter((t) => t.role === "user");
    if (turns.length === 0) continue;
    items.push({
      source: "prompt",
      ref: path.basename(file, ".jsonl"),
      detail: `${turns.length} user prompts from a Claude Code session in this repo — signal for reasoning/intent, not for who wrote which line.`,
      content: turns.map((t) => t.text).join("\n---\n")
    });
  }
  return items;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const repo = repoRoot(opts.repo);

  console.error(`Repo: ${repo}`);
  console.error(`Attribution log: ${attributionLogPath()}`);
  console.error(`Since: ${opts.since} | max commits: ${opts.maxCommits} | forests: ${opts.forests.join(",")}`);
  console.error(
    `Claude backend: ${opts.claudeBackend}${opts.claudeBackend === "cli" ? ` (${opts.claudeCliPath})` : ""} | model: ${opts.model}`
  );

  const existing = loadExistingForest(opts.out);

  const deepDive = resolveDeepDiveTopics(opts.deepDiveLabels, existing);
  if (opts.deepDiveLabels.length > 0) {
    if (deepDive.resolved.length > 0) {
      console.error(
        `Deep dive requested for: ${deepDive.resolved.map((t) => `[${t.forestKind}] ${t.path.join(" > ")}`).join(", ")}`
      );
    }
    if (deepDive.notFound.length > 0) {
      console.error(
        `Deep dive: label(s) not found in the existing forest, skipped: ${deepDive.notFound.join(", ")}`
      );
    }
  }

  const reopen = resolveDeepDiveTopics(opts.reopenLabels, existing);
  if (opts.reopenLabels.length > 0) {
    if (reopen.resolved.length > 0) {
      console.error(
        `Re-review requested for: ${reopen.resolved.map((t) => `[${t.forestKind}] ${t.path.join(" > ")}`).join(", ")} (proficiency/evidence may update this run only; provenance stays frozen afterward unless re-reviewed again)`
      );
    }
    if (reopen.notFound.length > 0) {
      console.error(
        `Re-review: label(s) not found in the existing forest, skipped: ${reopen.notFound.join(", ")}`
      );
    }
  }

  let evidence = gatherGitEvidence(repo, opts.since, opts.maxCommits);
  if (opts.includePrompts) {
    evidence = evidence.concat(gatherPromptEvidence(repo));
  }
  evidence = truncateEvidence(evidence, opts.maxChars);
  console.error(`Evidence items gathered: ${evidence.length}`);

  const guidelinesPath = path.join(__dirname, "..", "..", "taxonomy-guidelines.md");
  const guidelines = fs.readFileSync(guidelinesPath, "utf8");
  const systemPrompt = buildSystemPrompt(guidelines, deepDive.resolved);
  const userContent = buildUserContent(opts.forests, evidence, existing);

  if (opts.dryRun) {
    const promptOut = path.join(path.dirname(opts.out), "dry-run-prompt.txt");
    fs.mkdirSync(path.dirname(promptOut), { recursive: true });
    fs.writeFileSync(promptOut, `=== SYSTEM ===\n${systemPrompt}\n\n=== USER ===\n${userContent}\n`, "utf8");
    console.error(`Dry run — no API call made. Prompt written to ${promptOut} (${systemPrompt.length + userContent.length} chars).`);
    return;
  }

  const callClaude = createClaudeCaller({
    backend: opts.claudeBackend,
    model: opts.model,
    cliPath: opts.claudeCliPath
  });
  const raw = await callClaude(systemPrompt, userContent);
  const incoming = parseForestResponse(raw);
  const merged = mergeForest(existing, incoming, reopen.resolved);

  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  fs.writeFileSync(opts.out, JSON.stringify(merged, null, 2) + "\n", "utf8");

  const added = countNodes(incoming);
  console.error(`Done. ${added} ai-provenance node(s) proposed this run. Wrote ${opts.out}.`);
}

function countNodes(forest: ForestFile): number {
  const count = (nodes: { children: unknown[]; latent: unknown[] }[]): number =>
    nodes.reduce((sum, n) => sum + 1 + count(n.children as never) + count(n.latent as never), 0);
  return count(forest.tech as never) + count(forest.cs as never) + count(forest.practice as never);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
