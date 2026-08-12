import { test, describe, afterEach, beforeEach } from "vitest";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NodeLockFileWatcherAdapter } from "../../src/adapters/lock-file-watcher.ts";

describe("NodeLockFileWatcherAdapter", () => {
  let configDir: string;
  let workspaceRoot: string;
  let prevOverride: string | undefined;

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "tourist-lockfile-config-"));
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tourist-lockfile-workspace-"));
    prevOverride = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    if (prevOverride === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevOverride;
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("REVIEW_SENIOR.md finding #4: a stale lock file left by a SIGKILL'd session (dead pid) does not falsely corroborate by default, now that spike experiment 2 confirmed the liveness check is necessary", () => {
    const ideDir = path.join(configDir, "ide");
    fs.mkdirSync(ideDir, { recursive: true });
    fs.writeFileSync(
      path.join(ideDir, "stale.lock"),
      JSON.stringify({ pid: 999999, workspaceFolders: [workspaceRoot] }),
      "utf8"
    );

    // Default options -- no explicit pidLivenessCheck override -- is exactly
    // the production wiring in src/extension.ts.
    const adapter = new NodeLockFileWatcherAdapter();
    const activeSignals: boolean[] = [];
    adapter.onDidChangeSignal((_root, signal) => activeSignals.push(signal.active));
    try {
      adapter.start([workspaceRoot]);
      assert.equal(activeSignals.includes(true), false, "a dead-pid lock file must not corroborate by default");
    } finally {
      adapter.dispose();
    }
  });

  test("a lock file with a live pid still corroborates by default", () => {
    const ideDir = path.join(configDir, "ide");
    fs.mkdirSync(ideDir, { recursive: true });
    fs.writeFileSync(
      path.join(ideDir, "live.lock"),
      JSON.stringify({ pid: process.pid, workspaceFolders: [workspaceRoot] }),
      "utf8"
    );

    const adapter = new NodeLockFileWatcherAdapter();
    const activeSignals: boolean[] = [];
    adapter.onDidChangeSignal((_root, signal) => activeSignals.push(signal.active));
    try {
      adapter.start([workspaceRoot]);
      assert.equal(activeSignals.includes(true), true, "a live-pid lock file must still corroborate");
    } finally {
      adapter.dispose();
    }
  });
});
