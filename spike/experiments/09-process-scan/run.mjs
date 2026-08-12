// Experiment 9 -- process-scan viability via ps-list (PLAN1.md Phase 0 item 9).
// Confirms whether ps-list can correlate a running `claude` process to a
// specific workspace path via cwd/cmd on this machine (macOS).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import psList from "ps-list";

const execFileAsync = promisify(execFile);

async function main() {
  const platform = process.platform;
  console.log(`platform: ${platform}`);

  const all = await psList();
  console.log(`total processes seen by ps-list: ${all.length}`);

  const truncate = (s, n = 100) => (s && s.length > n ? s.slice(0, n) + "...[truncated]" : s);
  const claudeLike = all.filter((p) => /claude/i.test(p.name ?? "") || /claude/i.test(p.cmd ?? ""));
  console.log(`processes matching /claude/i by name or cmd: ${claudeLike.length}`);
  for (const p of claudeLike) {
    console.log(JSON.stringify({ ...p, cmd: truncate(p.cmd) }, null, 2));
  }

  const sample = all[0];
  console.log("\nsample process shape (first entry) -- which fields does ps-list actually populate on this platform:");
  console.log(JSON.stringify(sample, null, 2));
  console.log("\nfields present across ALL processes (union of keys):");
  const keys = new Set();
  for (const p of all) for (const k of Object.keys(p)) keys.add(k);
  console.log([...keys].sort());

  // Cross-check: does ps-list's `cmd` field on macOS actually carry the cwd,
  // or only the command line? macOS `ps` does not expose a per-process cwd
  // column at all without extra privileges/tools (lsof -a -p <pid> -d cwd),
  // so cross-check independently via lsof for any claude-like pids found.
  if (claudeLike.length > 0) {
    console.log("\ncross-checking cwd via `lsof -a -p <pid> -d cwd` for each matched pid:");
    for (const p of claudeLike) {
      try {
        const { stdout } = await execFileAsync("lsof", ["-a", "-p", String(p.pid), "-d", "cwd", "-Fn"]);
        console.log(`pid ${p.pid}: ${stdout.trim().split("\n").filter((l) => l.startsWith("n")).join(" ")}`);
      } catch (err) {
        console.log(`pid ${p.pid}: lsof failed -- ${err.message}`);
      }
    }
  } else {
    console.log("\nno claude-like process found by ps-list at scan time (expected if none is running right now).");
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
