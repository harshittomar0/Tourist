// Tourist Phase 0 spike -- disposable instrumentation/logging harness.
// Covers (see spike/FINDINGS.md for results):
//   - Experiment 1 harness (built here, NOT run here -- needs a human driving
//     the real Claude Code VS Code extension's diff Accept/Reject UI).
//   - Experiment 6 (git extension branch-change events), self-driving when
//     TOURIST_SPIKE_AUTOTEST=1 is set -- no human interaction required since
//     it only observes git-extension state changes in response to plain git
//     commands, not any third-party extension's UI.
"use strict";
const vscode = require("vscode");
const path = require("node:path");
const fs = require("node:fs");
const cp = require("node:child_process");

let logStream;

function logPath() {
  return process.env.TOURIST_SPIKE_LOG || path.join(__dirname, "logs", `run-${Date.now()}.jsonl`);
}

function log(event) {
  const line = JSON.stringify({ t: Date.now(), ...event }) + "\n";
  fs.appendFileSync(logStream, line);
  console.log("[tourist-spike]", line.trim());
}

function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    cp.execFile(cmd, args, { cwd }, (error, stdout, stderr) => {
      resolve({ error: error ? String(error.message) : null, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function activate(context) {
  logStream = logPath();
  fs.mkdirSync(path.dirname(logStream), { recursive: true });
  log({
    type: "activate",
    vscodeVersion: vscode.version,
    workspaceFolders: (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath),
  });

  // -------------------------------------------------------------------
  // Experiment 1 harness -- instrumentation only. Nothing here drives the
  // real Claude Code extension's UI; a human must do that manually (see
  // spike/FINDINGS.md "Experiment 1 -- manual run instructions").
  // -------------------------------------------------------------------
  const lastDirty = new Map();
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      log({
        type: "onDidChangeTextDocument",
        uri: e.document.uri.toString(),
        isDirty: e.document.isDirty,
        reason: e.reason === undefined ? null : e.reason,
        changeCount: e.contentChanges.length,
        ranges: e.contentChanges.map((c) => ({ rangeOffset: c.rangeOffset, rangeLength: c.rangeLength, textLength: c.text.length })),
      });
      lastDirty.set(e.document.uri.toString(), e.document.isDirty);
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      log({ type: "onDidSaveTextDocument", uri: doc.uri.toString(), isDirty: doc.isDirty });
      lastDirty.set(doc.uri.toString(), doc.isDirty);
    })
  );
  // Fast poll to catch isDirty transitions that occur without a matching
  // change/save event on the plain tab (e.g. a silent reload) -- this is
  // exactly the signal Experiment 1 needs to distinguish "clean->clean
  // identical to bare CLI" from "transient dirtying" during diff review.
  const pollInterval = setInterval(() => {
    for (const doc of vscode.workspace.textDocuments) {
      const key = doc.uri.toString();
      const prev = lastDirty.get(key);
      if (prev !== doc.isDirty) {
        log({ type: "isDirtyPollTransition", uri: key, from: prev ?? null, to: doc.isDirty });
        lastDirty.set(key, doc.isDirty);
      }
    }
  }, 75);
  context.subscriptions.push({ dispose: () => clearInterval(pollInterval) });

  // -------------------------------------------------------------------
  // Experiment 6 -- git extension branch-change events.
  // -------------------------------------------------------------------
  setupGitExperiment(context).catch((err) => log({ type: "exp6-fatal-error", message: String(err) }));

  // -------------------------------------------------------------------
  // Experiment 5 -- contentChanges ordering.
  // -------------------------------------------------------------------
  if (process.env.TOURIST_SPIKE_AUTOTEST_EXP5 === "1") {
    runContentChangesOrderingTest(context).catch((err) => log({ type: "exp5-fatal-error", message: String(err) }));
  }

  // -------------------------------------------------------------------
  // Experiment 3 -- shell integration precision.
  // -------------------------------------------------------------------
  if (process.env.TOURIST_SPIKE_AUTOTEST_EXP3 === "1") {
    runShellIntegrationTest(context).catch((err) => log({ type: "exp3-fatal-error", message: String(err) }));
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("touristSpike.dumpLog", () => {
      vscode.window.showInformationMessage(`Tourist spike log: ${logStream}`);
    })
  );
}

// ---------------------------------------------------------------------
// Experiment 5 -- contentChanges ordering (PLAN1.md Phase 0 item 5).
// Forces multi-range edits (multi-cursor-style batched edit, a
// programmatic "replace all occurrences", and a formatter rewriting
// several separate spans) and logs the raw event.contentChanges range
// order every time, to confirm whether it can still arrive non-
// bottom-to-top on the pinned VS Code version (MS bug reports #11487,
// #111548).
// ---------------------------------------------------------------------
async function runContentChangesOrderingTest(context) {
  log({ type: "exp5-start" });

  const changeLog = [];
  const sub = vscode.workspace.onDidChangeTextDocument((e) => {
    if (!e.document.uri.toString().includes("tourist-spike-exp5")) return;
    const entry = {
      type: "exp5-contentChanges",
      changeCount: e.contentChanges.length,
      ranges: e.contentChanges.map((c) => ({
        startLine: c.range.start.line,
        endLine: c.range.end.line,
        rangeOffset: c.rangeOffset,
        text: c.text,
      })),
    };
    changeLog.push(entry);
    log(entry);
  });
  context.subscriptions.push(sub);

  const uri = vscode.Uri.file(process.env.TOURIST_SPIKE_EXP5_FILE);
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc);

  // --- (a) multi-cursor-style batched edit: issue replacements in a
  // deliberately scrambled call order (line 2, then line 0, then line 4)
  // within ONE editor.edit() callback -- exactly how a real multi-cursor
  // edit or "Replace All" batches multiple ranges into one document-change
  // event.
  log({ type: "exp5-issuing-multi-range-edit", callOrder: ["line2", "line0", "line4"] });
  await editor.edit((builder) => {
    builder.replace(doc.lineAt(2).range, "CCCC_EDITED");
    builder.replace(doc.lineAt(0).range, "AAAA_EDITED");
    builder.replace(doc.lineAt(4).range, "EEEE_EDITED");
  });
  await new Promise((r) => setTimeout(r, 300));

  // --- (b) a formatter rewriting several separate spans in one pass,
  // returned in a deliberately scrambled order (last-line edit pushed
  // first in the returned array).
  log({ type: "exp5-issuing-formatter-edit" });
  const providerDisposable = vscode.languages.registerDocumentFormattingEditProvider(
    { pattern: "**/tourist-spike-exp5*.txt" },
    {
      provideDocumentFormattingEdits(document) {
        const last = document.lineCount - 1;
        return [
          vscode.TextEdit.replace(document.lineAt(last).range, "LAST_LINE_FORMATTED"),
          vscode.TextEdit.replace(document.lineAt(1).range, "LINE1_FORMATTED"),
        ];
      },
    }
  );
  context.subscriptions.push(providerDisposable);
  await vscode.commands.executeCommand("editor.action.formatDocument");
  await new Promise((r) => setTimeout(r, 300));

  log({ type: "exp5-done", totalContentChangeEvents: changeLog.length });
  await new Promise((r) => setTimeout(r, 300));
  if (process.env.TOURIST_SPIKE_AUTOCLOSE === "1") {
    vscode.commands.executeCommand("workbench.action.closeWindow");
  }
}

async function setupGitExperiment(context) {
  let gitExtension = vscode.extensions.getExtension("vscode.git");
  if (!gitExtension) {
    // Retry briefly -- the extension registry may not be fully populated at
    // the instant this "onStartupFinished" activation runs.
    for (let i = 0; i < 20 && !gitExtension; i++) {
      await new Promise((r) => setTimeout(r, 250));
      gitExtension = vscode.extensions.getExtension("vscode.git");
    }
  }
  if (!gitExtension) {
    log({ type: "exp6-git-extension-not-found", allExtensionIds: vscode.extensions.all.map((e) => e.id) });
    if (process.env.TOURIST_SPIKE_AUTOCLOSE === "1") vscode.commands.executeCommand("workbench.action.closeWindow");
    return;
  }
  const gitExports = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
  const api = gitExports.getAPI(1);

  const describeRepo = (repo) => ({
    root: repo.rootUri.fsPath,
    head: repo.state.HEAD ? { name: repo.state.HEAD.name, commit: repo.state.HEAD.commit, type: repo.state.HEAD.type } : null,
  });

  log({ type: "exp6-initial-repositories", repositories: api.repositories.map(describeRepo) });

  const wireRepo = (repo) => {
    log({ type: "exp6-repo-wired", ...describeRepo(repo) });
    let lastHead = repo.state.HEAD ? repo.state.HEAD.name : null;
    context.subscriptions.push(
      repo.state.onDidChange
        ? repo.state.onDidChange(() => onRepoStateChange())
        : { dispose() {} }
    );
    // Also verify the repository-level `onDidChangeState` surface (present on
    // the ApiRepository wrapper per the bundled vscode.git dist/main.js --
    // both are logged so we can confirm which one is public/reliable).
    if (typeof repo.onDidChangeState === "function") {
      context.subscriptions.push(repo.onDidChangeState(() => onRepoStateChange("repo.onDidChangeState")));
    }
    function onRepoStateChange(source = "repo.state.onDidChange") {
      const newHead = repo.state.HEAD ? repo.state.HEAD.name : null;
      log({
        type: "exp6-state-change",
        source,
        root: repo.rootUri.fsPath,
        headBefore: lastHead,
        headAfter: newHead,
        branchActuallyChanged: newHead !== lastHead,
      });
      lastHead = newHead;
    }
  };

  api.repositories.forEach(wireRepo);
  context.subscriptions.push(api.onDidOpenRepository((repo) => { log({ type: "exp6-onDidOpenRepository", ...describeRepo(repo) }); wireRepo(repo); }));
  context.subscriptions.push(api.onDidCloseRepository((repo) => log({ type: "exp6-onDidCloseRepository", root: repo.rootUri.fsPath })));

  if (process.env.TOURIST_SPIKE_AUTOTEST === "1") {
    await new Promise((r) => setTimeout(r, 1500));
    await runAutotest(api, describeRepo);
  }
}

async function runAutotest(api, describeRepo) {
  log({ type: "exp6-autotest-start" });
  if (api.repositories.length === 0) {
    log({ type: "exp6-autotest-no-repo-found" });
  } else {
    const repo = api.repositories[0];
    const cwd = repo.rootUri.fsPath;
    log({ type: "exp6-autotest-issuing-checkout", cwd, target: "spike-branch-a", command: "git checkout -b spike-branch-a" });
    let issuedAt = Date.now();
    await run("git", ["checkout", "-b", "spike-branch-a"], cwd);
    log({ type: "exp6-autotest-checkout-issued", issuedAt });
    await new Promise((r) => setTimeout(r, 4000));

    log({ type: "exp6-autotest-issuing-commit-on-branch", cwd, command: "echo change >> f.txt && git commit -am change" });
    issuedAt = Date.now();
    await run("bash", ["-c", "echo change >> f.txt && git commit -am change"], cwd);
    log({ type: "exp6-autotest-commit-issued", issuedAt });
    await new Promise((r) => setTimeout(r, 4000));

    log({ type: "exp6-autotest-issuing-checkout", cwd, target: "main", command: "git checkout main" });
    issuedAt = Date.now();
    await run("git", ["checkout", "main"], cwd);
    log({ type: "exp6-autotest-checkout-issued", issuedAt });
    await new Promise((r) => setTimeout(r, 4000));

    log({ type: "exp6-autotest-issuing-rebase", cwd, command: "git rebase -q spike-branch-a" });
    issuedAt = Date.now();
    await run("git", ["rebase", "spike-branch-a"], cwd);
    log({ type: "exp6-autotest-rebase-issued", issuedAt });
    await new Promise((r) => setTimeout(r, 4000));
  }

  log({ type: "exp6-autotest-done" });
  await new Promise((r) => setTimeout(r, 500));
  if (process.env.TOURIST_SPIKE_AUTOCLOSE === "1") {
    vscode.commands.executeCommand("workbench.action.closeWindow");
  }
}

// ---------------------------------------------------------------------
// Experiment 3 -- shell integration precision (PLAN1.md Phase 0 item 3).
// Logs onDidStartTerminalShellExecution for a real `claude --version`
// invocation in a VS Code integrated terminal (a fast, harmless, real
// invocation -- not a full agentic session, so it needs no permission
// bypass and no isolated auth) to check commandLine.value,
// commandLine.confidence, and cwd; separately checks a terminal profile
// with shell integration unlikely/unable to activate.
// ---------------------------------------------------------------------
async function runShellIntegrationTest(context) {
  log({ type: "exp3-start" });

  context.subscriptions.push(
    vscode.window.onDidStartTerminalShellExecution((e) => {
      log({
        type: "exp3-onDidStartTerminalShellExecution",
        terminalName: e.terminal.name,
        commandLineValue: e.execution.commandLine.value,
        commandLineConfidence: e.execution.commandLine.confidence,
        commandLineIsTrusted: e.execution.commandLine.isTrusted,
        cwd: e.execution.cwd ? e.execution.cwd.fsPath : null,
      });
    })
  );
  context.subscriptions.push(
    vscode.window.onDidEndTerminalShellExecution((e) => {
      log({ type: "exp3-onDidEndTerminalShellExecution", terminalName: e.terminal.name, exitCode: e.exitCode });
    })
  );
  context.subscriptions.push(
    vscode.window.onDidChangeTerminalShellIntegration((e) => {
      log({ type: "exp3-onDidChangeTerminalShellIntegration", terminalName: e.terminal.name, hasShellIntegration: !!e.shellIntegration });
    })
  );

  const shell = process.env.TOURIST_SPIKE_EXP3_SHELL;
  const terminal = vscode.window.createTerminal({ name: `exp3-${shell || "default"}`, shellPath: shell || undefined, cwd: process.env.TOURIST_SPIKE_EXP3_CWD });
  log({ type: "exp3-terminal-created", name: terminal.name, shell: shell || "(default)" });
  terminal.show();

  // Give shell integration time to attach before sending a command --
  // matches VS Code's own documented pattern of waiting for
  // onDidChangeTerminalShellIntegration before relying on the API.
  await new Promise((r) => setTimeout(r, 2500));
  log({ type: "exp3-shellIntegration-property-check", hasShellIntegration: !!terminal.shellIntegration });
  log({ type: "exp3-sending-command", command: "claude --version" });
  terminal.sendText("claude --version");
  await new Promise((r) => setTimeout(r, 4000));
  log({ type: "exp3-shellIntegration-property-check-after", hasShellIntegration: !!terminal.shellIntegration });

  log({ type: "exp3-done" });
  await new Promise((r) => setTimeout(r, 300));
  if (process.env.TOURIST_SPIKE_AUTOCLOSE === "1") {
    vscode.commands.executeCommand("workbench.action.closeWindow");
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
