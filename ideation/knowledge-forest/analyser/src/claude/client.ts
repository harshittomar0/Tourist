import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";

export interface ClaudeCaller {
  (systemPrompt: string, userContent: string): Promise<string>;
}

export type ClaudeBackend = "cli" | "api-key";

export const DEFAULT_MODEL = "claude-sonnet-5";
export const DEFAULT_CLI_PATH = "claude";
export const DEFAULT_CLI_TIMEOUT_MS = 120_000;

export interface ClaudeCallerOptions {
  /** Which backend to invoke. Defaults to "cli" — no API key required, reuses whatever `claude` login/auth is already on the machine. */
  backend?: ClaudeBackend;
  model?: string;
  /** Only used when backend is "api-key". */
  apiKey?: string;
  /** Only used when backend is "cli". */
  cliPath?: string;
  /** Only used when backend is "cli". */
  cliTimeoutMs?: number;
}

/**
 * Picks a backend by option, not by module — buildPrompt.ts and cli.ts only
 * ever depend on the `ClaudeCaller` function signature, so neither cares
 * which of createApiKeyClaudeCaller / createCliClaudeCaller actually ran.
 */
export function createClaudeCaller(options: ClaudeCallerOptions = {}): ClaudeCaller {
  const backend = options.backend ?? "cli";
  return backend === "cli"
    ? createCliClaudeCaller(options.model, options.cliPath, options.cliTimeoutMs)
    : createApiKeyClaudeCaller(options.apiKey, options.model);
}

/**
 * Calls the Anthropic API directly with an API key. Deliberately requires
 * an explicit, human-provided key — see PLAN.md "Privacy boundary." It will
 * never run implicitly.
 */
export function createApiKeyClaudeCaller(
  apiKey = process.env.ANTHROPIC_API_KEY,
  model = DEFAULT_MODEL
): ClaudeCaller {
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. This pipeline calls the Anthropic API directly and deliberately requires " +
        "an explicit, human-provided key — see PLAN.md 'Privacy boundary.' It will never run implicitly."
    );
  }
  const client = new Anthropic({ apiKey });

  return async (systemPrompt: string, userContent: string): Promise<string> => {
    const response = await client.messages.create({
      model,
      max_tokens: 8192,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }]
    });
    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("Claude response contained no text block.");
    }
    return textBlock.text;
  };
}

export class ClaudeCliError extends Error {}

/**
 * Loose on purpose: this only needs to get the CLI's structured-output
 * validator to agree the top-level shape is a ForestFile. The real,
 * strict, recursive validation of each ForestNode (evidence required,
 * provenance forced to "ai", proficiency clamped) happens in
 * forest/validate.ts regardless of which backend produced the JSON — see
 * that module's docstring for why it never trusts the model either way.
 */
const FOREST_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    tech: { type: "array", items: { type: "object" } },
    cs: { type: "array", items: { type: "object" } },
    practice: { type: "array", items: { type: "object" } }
  }
};

interface ClaudeCliResult {
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
}

/**
 * Ports tourist-raw's `_run_claude_cli` (python/tourist/scoring/score.py):
 * shells out to the already-authenticated `claude` CLI in one-shot mode
 * instead of calling the API directly, so this backend needs no
 * ANTHROPIC_API_KEY — whatever auth `claude` itself is logged in with is
 * reused. Unlike the ported version, this adds a hard wall-clock timeout —
 * a hung CLI process would otherwise block the pipeline forever.
 */
export function createCliClaudeCaller(
  model = DEFAULT_MODEL,
  cliPath = DEFAULT_CLI_PATH,
  timeoutMs = DEFAULT_CLI_TIMEOUT_MS
): ClaudeCaller {
  return (systemPrompt: string, userContent: string): Promise<string> =>
    runClaudeCli({ cliPath, model, systemPrompt, userContent, timeoutMs });
}

interface RunClaudeCliOptions {
  cliPath: string;
  model: string;
  systemPrompt: string;
  userContent: string;
  timeoutMs: number;
}

function runClaudeCli(opts: RunClaudeCliOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      "--output-format",
      "json",
      "--model",
      opts.model,
      "--no-session-persistence",
      "--system-prompt",
      opts.systemPrompt,
      "--json-schema",
      JSON.stringify(FOREST_RESPONSE_SCHEMA)
    ];

    const child = spawn(opts.cliPath, args, { stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new ClaudeCliError(`claude CLI timed out after ${opts.timeoutMs}ms.`));
    }, opts.timeoutMs);

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    child.on("error", (err) => {
      finish(() => {
        reject(
          new ClaudeCliError(
            `claude CLI not found: could not launch "${opts.cliPath}" (${err.message}). Make sure the Claude ` +
              `Code CLI is installed and on your PATH, or pass --claude-cli-path.`
          )
        );
      });
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("close", (code) => {
      finish(() => {
        if (code !== 0) {
          const detail = (stderr || stdout).trim();
          reject(new ClaudeCliError(`claude CLI exited with code ${code}: ${detail}`));
          return;
        }

        let parsed: ClaudeCliResult;
        try {
          parsed = JSON.parse(stdout);
        } catch (err) {
          reject(new ClaudeCliError(`Could not parse claude CLI output as JSON: ${(err as Error).message}`));
          return;
        }

        if (parsed.is_error || !parsed.structured_output) {
          reject(new ClaudeCliError(`claude CLI reported an error: ${parsed.result ?? "unknown error"}`));
          return;
        }

        resolve(JSON.stringify(parsed.structured_output));
      });
    });

    // Swallow EPIPE-style stream errors on stdin when the process never
    // spawned (ENOENT) — the 'error' handler above already reports that.
    child.stdin?.on("error", () => {});
    try {
      child.stdin?.write(opts.userContent);
      child.stdin?.end();
    } catch {
      // ignore — handled by the 'error' event
    }
  });
}
