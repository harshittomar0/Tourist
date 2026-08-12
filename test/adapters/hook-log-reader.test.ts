import { test, describe } from "vitest";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { FileHookLogReaderAdapter } from "../../src/adapters/hook-log-reader.ts";

const HOOK_SCRIPT = path.resolve(__dirname, "..", "..", "hooks", "attribution-hook.mjs");

function sha1(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex");
}

function runHook(payload: unknown, configDir: string): void {
  const result = spawnSync(process.execPath, [HOOK_SCRIPT], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
  });
  assert.equal(result.status, 0, result.stderr);
}

describe("FileHookLogReaderAdapter.install()/isInstalled() -- the single canonical hook-install implementation (REVIEW_JRDEV.md finding #4: hook-install.ts now delegates here instead of duplicating this logic)", () => {
  test("install() writes settings.json inside CLAUDE_CONFIG_DIR, referencing the real attribution-hook.mjs filename, and isInstalled() then reports true", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "tourist-hook-install-"));
    const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    try {
      process.env.CLAUDE_CONFIG_DIR = configDir;
      const reader = new FileHookLogReaderAdapter(HOOK_SCRIPT);

      const before = await reader.isInstalled();
      assert.equal(before, false);

      const { alreadyInstalled } = await reader.install();
      assert.equal(alreadyInstalled, false);

      const settingsPath = path.join(configDir, "settings.json");
      assert.equal(fs.existsSync(settingsPath), true, "settings.json must land inside the CLAUDE_CONFIG_DIR override, not the real home directory");
      const written = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      const command = `node ${JSON.stringify(HOOK_SCRIPT)}`;
      assert.ok(written.hooks.PreToolUse.some((e: { hooks: { command: string }[] }) => e.hooks.some((h) => h.command === command)));
      assert.ok(written.hooks.PostToolUse.some((e: { hooks: { command: string }[] }) => e.hooks.some((h) => h.command === command)));
      assert.match(command, /attribution-hook\.mjs/);

      const after = await reader.isInstalled();
      assert.equal(after, true);

      const second = await reader.install();
      assert.equal(second.alreadyInstalled, true, "install() must be idempotent");
      reader.dispose();
    } finally {
      if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });
});

describe("FileHookLogReaderAdapter + attribution-hook.mjs with CLAUDE_CONFIG_DIR override", () => {
  test("attribution log lands inside the override dir, not as its sibling", () => {
    const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tourist-hook-config-dir-"));
    const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    try {
      // Nest the override under scratchRoot so a `path.dirname(override)` bug
      // would land the log in scratchRoot itself instead of inside override.
      const override = path.join(scratchRoot, "claude-config-override");
      fs.mkdirSync(override, { recursive: true });

      const targetFile = path.join(scratchRoot, "workspace", "example.ts");
      fs.mkdirSync(path.dirname(targetFile), { recursive: true });
      fs.writeFileSync(targetFile, "line one\nline two\n", "utf8");

      const basePayload = {
        session_id: "test-session",
        cwd: scratchRoot,
        tool_name: "Edit",
        tool_input: { file_path: targetFile },
      };

      runHook({ ...basePayload, hook_event_name: "PreToolUse" }, override);

      const newContent = "line one\nline two\nline three\n";
      fs.writeFileSync(targetFile, newContent, "utf8");

      runHook(
        { ...basePayload, hook_event_name: "PostToolUse", tool_response: { success: true } },
        override
      );

      const correctLogFile = path.join(override, "tourist-attribution", "ai-edits.jsonl");
      const siblingLogFile = path.join(scratchRoot, "tourist-attribution", "ai-edits.jsonl");

      assert.equal(fs.existsSync(correctLogFile), true, "expected the log inside the override dir");
      assert.equal(fs.existsSync(siblingLogFile), false, "log must not land as a sibling of the override dir");

      process.env.CLAUDE_CONFIG_DIR = override;
      const reader = new FileHookLogReaderAdapter(HOOK_SCRIPT);
      assert.equal(reader.matchesContent(targetFile, sha1(newContent)), true);
      reader.dispose();
    } finally {
      if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
      fs.rmSync(scratchRoot, { recursive: true, force: true });
    }
  });
});
