/**
 * Builds the analyser CLI invocation and runs it as a subprocess. No
 * `vscode` import -- pure enough to unit test without an extension host.
 *
 * The flag set below (`--claude-backend`/`--claude-cli-path`/`--model`/
 * `--since`/`--max-commits`/`--forest`/`--include-prompts`/`--deep-dive`)
 * matches ideation/knowledge-forest/analyser/src/cli.ts's real, landed
 * interface. Note `--out` (not `--forest`) is the output-path flag --
 * cli.ts's own `--forest` takes a comma-separated list of forest *kinds*
 * (tech/cs/practice), a different thing entirely; passing a JSON path
 * there silently filters down to zero kinds instead of erroring.
 * `looksLikeUnsupportedFlags` stays as a defensive check for a stale local
 * analyser build (built before a future flag change) rather than a crash.
 *
 * `--max-chars` and `--dry-run` are deliberately not surfaced here -- see
 * the audit report for why those two stay CLI-only.
 */
import { spawn } from "node:child_process";

export interface GenerateOptions {
  repoRoot: string;
  forestJsonPath: string;
  claudeBackend: "cli" | "api-key";
  claudeCliPath: string;
  model: string;
  since: string;
  maxCommits: number;
  forestKinds: string[];
  /** Opt-in, privacy-sensitive: reads real Claude Code session transcripts
   * as extra evidence. See settings.ts's `knowledgeMapIncludePrompts` and
   * commands.ts's dedicated consent dialog for this flag specifically. */
  includePrompts: boolean;
  /** Topic labels the user selected in the webview for a deep-dive pass --
   * see html.ts's "Deep Dive on Selected" affordance. Omitted/empty for a
   * normal whole-forest generate. */
  deepDiveTopics?: string[];
}

export function buildAnalyserArgs(opts: GenerateOptions): string[] {
  const args = [
    "--repo",
    opts.repoRoot,
    "--out",
    opts.forestJsonPath,
    "--since",
    opts.since,
    "--max-commits",
    String(opts.maxCommits),
    "--forest",
    opts.forestKinds.join(","),
    "--claude-backend",
    opts.claudeBackend,
    "--claude-cli-path",
    opts.claudeCliPath,
    "--model",
    opts.model,
  ];
  if (opts.includePrompts) {
    args.push("--include-prompts");
  }
  if (opts.deepDiveTopics && opts.deepDiveTopics.length > 0) {
    args.push("--deep-dive", opts.deepDiveTopics.join(","));
  }
  return args;
}

export interface RunResult {
  code: number | null;
  stderr: string;
}

export function runAnalyserCli(cliJsPath: string, args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliJsPath, ...args], { env });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => resolve({ code: -1, stderr: String(err) }));
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

/** cli.ts's `parseArgs` does `console.error("Unknown argument: ${arg}"); process.exit(1)`
 * for any flag it doesn't recognize -- this is how a caller tells "the CLI
 * ran and genuinely rejected one of our not-yet-supported flags" apart from
 * any other failure (a bad repo path, a Claude API error, etc). */
export function looksLikeUnsupportedFlags(stderr: string): boolean {
  return /Unknown argument/i.test(stderr);
}
