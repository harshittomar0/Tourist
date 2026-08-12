import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { HookLogReaderAdapter } from "../core/adapter-interfaces.ts";
import type { Disposable } from "../core/types.ts";

interface HookRecord {
  ts: number;
  cwd: string;
  file: string;
  tool: string;
  contentHash: string;
  aiRanges: Array<{ start: number; end: number }>;
  snippet: string;
}

function attributionDir(): string {
  const override = process.env.CLAUDE_CONFIG_DIR;
  const base = override ? path.dirname(override) : path.join(os.homedir(), ".claude");
  // Namespaced distinctly from tourist-raw's own `~/.claude/tourist/` so
  // both extensions can theoretically coexist installed side by side
  // without one's hook log clobbering the other's.
  return path.join(base, "tourist-attribution");
}

function logFile(): string {
  return path.join(attributionDir(), "ai-edits.jsonl");
}

/**
 * Default location of the bundled hook script, resolved relative to *this
 * source file* -- correct when running against src/ directly (tsx, unit
 * tests) or from an unbundled dist/ that mirrors src/'s layout. Uses
 * `__dirname` rather than `import.meta.url` since this project compiles to
 * CommonJS (see tsconfig.json / package.json, neither of which sets
 * `"type": "module"`), where `import.meta` isn't available.
 *
 * TODO(Phase 5 packaging, Agent C/D -- not a Phase 0 spike item): once
 * esbuild bundles src/extension.ts into a single dist/extension.js,
 * `__dirname`-relative resolution from *this* file no longer applies to the
 * bundled output. Whoever wires activation (Agent C) needs to pass an
 * explicit `scriptPath` (e.g. derived from `context.extensionUri` plus a
 * copied-as-asset `hooks/attribution-hook.mjs`) rather than relying on this
 * default once the extension is actually packaged.
 */
function defaultScriptPath(): string {
  return path.resolve(__dirname, "..", "..", "hooks", "attribution-hook.mjs");
}

interface ClaudeHookEntry {
  matcher: string;
  hooks: Array<{ type: "command"; command: string }>;
}

interface ClaudeSettings {
  hooks?: {
    PreToolUse?: ClaudeHookEntry[];
    PostToolUse?: ClaudeHookEntry[];
  };
  [key: string]: unknown;
}

const HOOK_MATCHER = "Edit|Write|MultiEdit";

function readSettings(settingsPath: string): ClaudeSettings {
  try {
    return JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    return {};
  }
}

function hasHookCommand(entries: ClaudeHookEntry[] | undefined, command: string): boolean {
  return !!entries?.some((entry) => entry.hooks.some((h) => h.command === command));
}

/**
 * Tier 1 ground truth: installs the PreToolUse/PostToolUse hook (mandatory
 * per GOAL1.md §2, unlike tourist-raw's optional install) and reads back its
 * JSONL log for exact-match cross-checks.
 *
 * TODO(Phase 0 experiment 4): this assumes the current Claude Code hook
 * *configuration* schema (a `hooks.PreToolUse`/`hooks.PostToolUse` array of
 * `{matcher, hooks: [{type: "command", command}]}` entries in
 * `~/.claude/settings.json`) matches tourist-raw's existing, working
 * pattern verbatim, and that hooks still fire for Edit/Write/MultiEdit
 * (including under `--worktree`) on the current CLI version. If experiment
 * 4 finds the schema changed, `install()`/`readSettings()`/`hasHookCommand()`
 * below are the only things that need to change -- the read-path
 * (`matchesContent`/`matchesSpan`, keyed on the *log file* this hook script
 * writes, which we also own) is unaffected either way.
 */
export class FileHookLogReaderAdapter implements HookLogReaderAdapter {
  private cache: { mtimeMs: number; size: number; records: HookRecord[] } | null = null;
  private pollHandle: NodeJS.Timeout | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly scriptPath: string = defaultScriptPath()) {}

  async install(): Promise<{ alreadyInstalled: boolean }> {
    const settingsPath = path.join(
      process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"),
      "settings.json"
    );
    const settings = readSettings(settingsPath);
    const command = `node ${JSON.stringify(this.scriptPath)}`;

    settings.hooks ??= {};
    const alreadyInstalled =
      hasHookCommand(settings.hooks.PreToolUse, command) && hasHookCommand(settings.hooks.PostToolUse, command);

    if (!alreadyInstalled) {
      settings.hooks.PreToolUse ??= [];
      settings.hooks.PostToolUse ??= [];
      if (!hasHookCommand(settings.hooks.PreToolUse, command)) {
        settings.hooks.PreToolUse.push({ matcher: HOOK_MATCHER, hooks: [{ type: "command", command }] });
      }
      if (!hasHookCommand(settings.hooks.PostToolUse, command)) {
        settings.hooks.PostToolUse.push({ matcher: HOOK_MATCHER, hooks: [{ type: "command", command }] });
      }
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
    }

    return { alreadyInstalled };
  }

  async isInstalled(): Promise<boolean> {
    const settingsPath = path.join(
      process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"),
      "settings.json"
    );
    const settings = readSettings(settingsPath);
    const command = `node ${JSON.stringify(this.scriptPath)}`;
    return hasHookCommand(settings.hooks?.PreToolUse, command) && hasHookCommand(settings.hooks?.PostToolUse, command);
  }

  matchesContent(absolutePath: string, contentHash: string): boolean {
    return this.records().some((r) => r.file === absolutePath && r.contentHash === contentHash);
  }

  matchesSpan(absolutePath: string, contentHash: string, lineStart: number, lineEnd: number): boolean {
    return this.records().some(
      (r) =>
        r.file === absolutePath &&
        r.contentHash === contentHash &&
        r.aiRanges.some((range) => range.start < lineEnd && range.end + 1 > lineStart)
    );
  }

  onDidAppendRecord(listener: () => void): Disposable {
    this.listeners.add(listener);
    if (!this.pollHandle) {
      // The hook script runs out-of-process (spawned by the Claude Code
      // CLI, not by this extension), so we can't get a push notification
      // for "a record was appended" any cheaper than watching the log file.
      try {
        fs.mkdirSync(attributionDir(), { recursive: true });
        const watcher = fs.watch(logFile(), { persistent: false }, () => {
          this.cache = null;
          for (const l of this.listeners) l();
        });
        this.pollHandle = setInterval(() => void 0, 0); // keep a handle around for dispose() symmetry
        this.pollHandle.unref?.();
        return { dispose: () => { this.listeners.delete(listener); watcher.close(); } };
      } catch {
        // No log directory yet -- nothing to watch until install()/first
        // hook run creates it; callers relying on this before then simply
        // won't be notified, which matches "no hook installed yet" reality.
      }
    }
    return { dispose: () => this.listeners.delete(listener) };
  }

  dispose(): void {
    if (this.pollHandle) clearInterval(this.pollHandle);
    this.pollHandle = null;
    this.listeners.clear();
  }

  private records(): HookRecord[] {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(logFile());
    } catch {
      this.cache = null;
      return [];
    }

    if (this.cache && this.cache.mtimeMs === stat.mtimeMs && this.cache.size === stat.size) {
      return this.cache.records;
    }

    let records: HookRecord[] = [];
    try {
      const lines = fs.readFileSync(logFile(), "utf8").split("\n").filter((l) => l.trim());
      records = lines.map((l) => JSON.parse(l));
    } catch {
      records = [];
    }

    this.cache = { mtimeMs: stat.mtimeMs, size: stat.size, records };
    return records;
  }
}
