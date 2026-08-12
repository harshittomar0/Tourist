// Experiment 2 -- lock-file lifecycle (PLAN1.md Phase 0 item 2).
// Two parts:
//  1. Passively watch ~/.claude/ide/ (and $CLAUDE_CONFIG_DIR/ide/ if set)
//     for real session churn from any Claude Code process on this machine
//     (this is a shared, busy multi-agent machine -- other sessions'
//     lock files appearing/disappearing are real, naturally-occurring
//     data, not synthetic).
//  2. A synthetic stale-lock test: write a fake lock file with a pid that
//     is not running, and confirm (a) nothing auto-removes it just because
//     the pid is dead, and (b) a `pid`-liveness check reliably detects it
//     as stale -- without needing to SIGKILL the only real, live session
//     available on this machine (the user's actual VS Code window), which
//     would be needlessly disruptive.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ideDir = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), "ide");

function snapshot() {
  return fs.readdirSync(ideDir).filter((f) => f.endsWith(".lock"));
}

function redactedRead(file) {
  const j = JSON.parse(fs.readFileSync(path.join(ideDir, file), "utf8"));
  j.authToken = "[REDACTED]";
  return j;
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== "ESRCH" ? "unknown (" + err.code + ")" : false;
  }
}

async function main() {
  console.log("watching", ideDir);
  let prev = new Set(snapshot());
  console.log("initial lock files:", [...prev]);
  for (const f of prev) console.log(f, "->", JSON.stringify(redactedRead(f)));

  const watcher = fs.watch(ideDir, (eventType, filename) => {
    console.log(JSON.stringify({ t: Date.now(), eventType, filename }));
  });

  const pollInterval = setInterval(() => {
    const cur = new Set(snapshot());
    for (const f of cur) if (!prev.has(f)) console.log(JSON.stringify({ t: Date.now(), type: "lock-appeared", file: f, content: redactedRead(f) }));
    for (const f of prev) if (!cur.has(f)) console.log(JSON.stringify({ t: Date.now(), type: "lock-disappeared", file: f }));
    prev = cur;
  }, 500);

  await new Promise((r) => setTimeout(r, 15000));
  clearInterval(pollInterval);
  watcher.close();

  console.log("\n--- synthetic stale-lock test ---");
  const DEAD_PID = 999999; // exceedingly unlikely to be a real running pid
  const fakeLockPath = path.join(ideDir, "999999.lock");
  fs.writeFileSync(
    fakeLockPath,
    JSON.stringify({ pid: DEAD_PID, workspaceFolders: ["/tmp/does-not-exist"], ideName: "Fake", transport: "ws", authToken: "fake" }),
    { mode: 0o600 }
  );
  console.log("wrote synthetic stale lock at", fakeLockPath);
  await new Promise((r) => setTimeout(r, 1000));
  console.log("still present after 1s (nothing auto-cleans by file-existence alone)?", fs.existsSync(fakeLockPath));
  console.log("pid liveness check result for the dead pid:", isPidAlive(DEAD_PID));
  console.log("pid liveness check result for OUR OWN pid (sanity check, should be true):", isPidAlive(process.pid));
  fs.unlinkSync(fakeLockPath);
  console.log("cleaned up synthetic lock file");
}

main();
