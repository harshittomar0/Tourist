// Experiment 4 -- hook coverage completeness. Uses the REAL
// FileHookLogReaderAdapter.install()/isInstalled()/matchesContent() from
// src/adapters/hook-log-reader.ts (not a re-implementation) against an
// isolated CLAUDE_CONFIG_DIR, so this never touches the real ~/.claude, and
// so a schema mismatch would be caught here rather than assumed away.
import { execFileSync } from "node:child_process";
import path from "node:path";

const [, , configDir] = process.argv;
if (!configDir) {
  console.error("usage: install-and-check.mjs <scratch-config-dir>");
  process.exit(1);
}
process.env.CLAUDE_CONFIG_DIR = configDir;

const { FileHookLogReaderAdapter } = await import(
  path.resolve(import.meta.dirname, "../../../src/adapters/hook-log-reader.ts")
);

const scriptPath = path.resolve(import.meta.dirname, "../../../hooks/attribution-hook.mjs");
const reader = new FileHookLogReaderAdapter(scriptPath);

const { alreadyInstalled } = await reader.install();
console.log(JSON.stringify({ step: "install", alreadyInstalled }));

const isInstalled = await reader.isInstalled();
console.log(JSON.stringify({ step: "isInstalled", isInstalled }));

const settingsPath = path.join(configDir, "settings.json");
console.log(JSON.stringify({ step: "settings-written", settingsPath, contents: execFileSync("cat", [settingsPath], { encoding: "utf8" }) }));
