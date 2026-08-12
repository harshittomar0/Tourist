/**
 * Builds the analyser CLI invocation and runs it as a subprocess. No
 * `vscode` import -- pure enough to unit test without an extension host.
 *
 * The flag set below (`--claude-backend`/`--claude-cli-path`/`--model`/
 * `--deep-dive`) is the *planned* interface two sibling workers are adding
 * to ideation/knowledge-forest/analyser/src/cli.ts in parallel (the Claude
 * CLI/api-key backend work, and tourist-15's `--deep-dive` topic-scoped
 * analysis flag). As of this writing neither has landed -- cli.ts only
 * parses --repo/--since/--out/--forest(comma-separated kinds)/--include-prompts/
 * --dry-run/--max-commits/--max-chars, and its `--forest` flag means
 * something different (forest *kinds*, not an output path) from the
 * `--forest <path>` used here. Per instructions, this deliberately does not
 * guess a different/compatible interface -- it's wired to the real, planned
 * one, and `looksLikeUnsupportedFlags` lets callers detect + report
 * "waiting on the sibling worker" instead of crashing confusingly when the
 * CLI rejects an argument it doesn't parse yet.
 */
import { spawn } from "node:child_process";

export interface GenerateOptions {
  repoRoot: string;
  forestJsonPath: string;
  claudeBackend: "cli" | "api-key";
  claudeCliPath: string;
  model: string;
  /** Topic labels the user selected in the webview for a deep-dive pass --
   * see html.ts's "Deep Dive on Selected" affordance. Omitted/empty for a
   * normal whole-forest generate. */
  deepDiveTopics?: string[];
}

export function buildAnalyserArgs(opts: GenerateOptions): string[] {
  const args = [
    "--repo",
    opts.repoRoot,
    "--forest",
    opts.forestJsonPath,
    "--claude-backend",
    opts.claudeBackend,
    "--claude-cli-path",
    opts.claudeCliPath,
    "--model",
    opts.model,
  ];
  if (opts.deepDiveTopics && opts.deepDiveTopics.length > 0) {
    // TODO(tourist-15): analyser/src/cli.ts doesn't parse --deep-dive yet.
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
