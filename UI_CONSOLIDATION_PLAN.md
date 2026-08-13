# Tourist UI Consolidation Plan

Status: planning document only. No implementation in this change.

## 1. Inventory (as of `origin/main`, `f0bce42`)

### Commands (`package.json` → `contributes.commands`, handlers in `src/vscode-integration/commands.ts` and `.../knowledge-map/commands.ts`)

| Command | Title | Handler | Notes |
|---|---|---|---|
| `tourist.openMenu` | Open Menu | `commands.ts` | Already a `QuickPick` aggregating 7 of the other commands (tracking/markers toggles, workspace view, install/verify hook, push/fetch notes). Also bound to an `editor/title` toolbar button (telescope icon). **Does not include** the two Knowledge Map commands. |
| `tourist.toggleTracking` | Toggle Attribution Tracking | `commands.ts` | Flips `tourist.attributionTracking`. |
| `tourist.toggleMarkers` | Toggle Attribution Line Markers | `commands.ts` | Flips `tourist.showAttributionMarkers`, refreshes decorations. |
| `tourist.installHook` | Install Claude Code Hook | `hook-install.ts` | Writes PreToolUse/PostToolUse hook into `~/.claude/settings.json`. |
| `tourist.verifyHook` | Verify Claude Code Hook | `hook-install.ts` | Checks script exists + hook registered; offers "Install Now" on failure. |
| `tourist.openWorkspaceView` | Open Workspace Attribution View | `commands.ts` | Refreshes `WorkspaceAttributionProvider` then runs `workbench.view.explorer`. |
| `tourist.pushAttributionNotes` | Push Attribution Notes | `commands.ts` | Gated on `tourist.gitNotesSync`; pushes `refs/notes/tourist-attribution`. |
| `tourist.fetchAttributionNotes` | Fetch Attribution Notes | `commands.ts` | Same gate; fetches, then refreshes workspace view. |
| `tourist.generateKnowledgeMap` | Generate Knowledge Map | `knowledge-map/commands.ts` | Gated on `tourist.knowledgeMap.enabled`; one-time modal consent; API-key prompt if backend is `api-key`; spawns analyser CLI. |
| `tourist.showKnowledgeMap` | Show Knowledge Map | `knowledge-map/commands.ts` | Opens/reveals the singleton `WebviewPanel` (`panel.ts`), `ViewColumn.Beside`. Webview has its own in-panel "Deep Dive on Selected" button that re-enters the same gated generate flow. |

Other contribution points already in `package.json`:
- `menus.editor/title`: one button → `tourist.openMenu`.
- `views.explorer`: `tourist.workspaceAttribution`, a `TreeView` (`workspace-view.ts`) showing per-folder/per-file ai/human/external rollups, nested under the built-in Explorer container.
- A status bar item (`status-bar.ts`) showing the workspace-total rollup; clicking it runs `tourist.openWorkspaceView`.

Not present on this `main` (mentioned in the task as conditional): no `tourist.deep-dive` or node-re-review command, no `tourist.knowledgeMap.includePrompts` setting. The plan below still allocates space for them since they're clearly coming.

### Settings (`package.json` → `contributes.configuration`, typed accessors in `src/vscode-integration/settings.ts`)

| Key | Type | Default | Purpose |
|---|---|---|---|
| `tourist.attributionTracking` | boolean | `true` | Master record on/off. |
| `tourist.showAttributionMarkers` | boolean | `true` | Show/hide editor decorations. |
| `tourist.attributionRetentionDays` | number | `3` | Marker aging window. |
| `tourist.exclusionPolicy` | string[] | `[]` | Extra gitignore-style globs. **Array-typed — the one setting native Settings UI renders worst.** |
| `tourist.gitNotesSync` | boolean | `false` | Gates push/fetch commands. |
| `tourist.gitNotesRemote` | string | `"origin"` | Remote name for push/fetch. |
| `tourist.knowledgeMap.enabled` | boolean | `false` | Master opt-in gate. |
| `tourist.knowledgeMap.claudeBackend` | enum (`cli`\|`api-key`) | `"cli"` | Backend selector. |
| `tourist.knowledgeMap.claudeCliPath` | string | `"claude"` | CLI path override. |
| `tourist.knowledgeMap.model` | string | `"claude-sonnet-5"` | Model used for analysis. |

### The core discoverability problem

`tourist.openMenu` already *is* a partial consolidation, but it's still a command you must know to invoke, it silently excludes Knowledge Map, and it's a transient QuickPick — it disappears the moment you pick something or hit Escape, so it can't show live status (is the hook installed? is tracking currently on?) without re-running it. There is no single surface a new user lands on that says "here is everything Tourist does and here is its current state."

## 2. Extension-point options, with tradeoffs

| Option | Strengths | Weaknesses | Verdict |
|---|---|---|---|
| **Sidebar Webview View** in a custom Activity Bar container | Persistent, always one click away, can show *live* state (toggle switches, hook status badge) without re-invoking anything, cheap to keep in sync via `postMessage` | Narrow (sidebar width ~300px) — bad for graphs, wide tables, or the Knowledge Map's node/tree visualization | Good for **status + quick actions**, bad for **deep content** |
| **Editor-area Webview Panel** (what Knowledge Map already uses) | Full editor real estate, good for graphs/tables/multi-step flows, users already have the mental model from Knowledge Map | Not persistent/ambient — has to be opened, competes with editor tabs, easy to forget it exists (the exact problem we're solving) | Good for **deep, occasional-use views**, bad as the sole *discovery* surface |
| **Custom Editor** (`vscode.CustomEditorProvider`) | Lets a view masquerade as a file-backed document (tab title, revert, etc.) | Designed for *editing a document type*; Tourist has no document to edit — this is the wrong abstraction, adds ceremony (custom editor provider, backup/serialization) for no benefit | Not applicable here |
| **Native Settings UI** (`contributes.configuration`) | Zero maintenance, searchable, syncs with Settings Sync, users already trust it for config | Renders `array` types (`exclusionPolicy`) as a bare add/remove string list with no validation/preview against the actual workspace; no room for a "pick topics" multi-step flow (deep-dive) | Keep it as the **source of truth for persistence**, but two specific interactions (exclusion globs, deep-dive picker) benefit from a lightweight custom control layered on top, not a replacement |

**Recommendation: combine the first two, keep Settings UI as-is.** A sidebar Webview View owns *status and quick actions* (the thing a QuickPick can't do because it's not persistent); the existing editor-area Webview Panel is generalized from "Knowledge Map panel" into a "Tourist Dashboard" that gains tabs for the other deep views (hook setup, git-notes sync). Native Settings stays the persistence layer for every setting; only `exclusionPolicy` gets a custom in-webview editor as a convenience, not a replacement.

This mirrors a pattern already implicit in the code: `status-bar.ts` treats `openWorkspaceView` as the "quick glance" affordance and the Knowledge Map panel as the "go deep" affordance. We're formalizing and extending that split rather than inventing a new one.

## 3. Proposed information architecture

### A. Activity Bar container: "Tourist" (`viewsContainers.activitybar`)

New icon in the Activity Bar (telescope, matching existing command icons). Replaces Tourist's current placement buried under the built-in Explorer container. Contains two views, top to bottom:

1. **`tourist.status`** — new sidebar **Webview View** (`contributes.views["tourist"]`, `type: "webview"`).
   - Live toggle switches for `attributionTracking` and `showAttributionMarkers` (read via `settings.ts`, write via the same `toggleTracking`/`toggleMarkers` commands — no new business logic, just buttons that call `vscode.commands.executeCommand`).
   - A hook status line: installed/not-installed badge, sourced from `verifyHookState()` (already exported from `hook-install.ts`), with an "Install"/"Verify" button.
   - A git-notes sync line: on/off + remote name (read-only display of `gitNotesSync`/`gitNotesRemote`), with Push/Fetch buttons that call the existing commands (which already handle the gate and remote name).
   - A "Knowledge Map" row: enabled/disabled state, "Generate" / "Open Dashboard" buttons.
   - A footer link "Open Tourist Dashboard" that opens the panel described below.
   - This view **replaces `tourist.openMenu`'s QuickPick as the primary discovery surface** but the command stays registered unchanged (cheap backward compatibility — existing muscle memory and the `editor/title` button keep working; that button can later be repointed to `workbench.view.extension.tourist` instead of the QuickPick, but that's a follow-up decision, not this plan's call to make).

2. **`tourist.workspaceAttribution`** — the **existing** `TreeView`/`WorkspaceAttributionProvider`, unchanged in code, just moved from `views.explorer` to `views.tourist` in `package.json`. Zero logic changes; this alone measurably improves discoverability today because it stops being one of a dozen unrelated things under "Explorer."

### B. Editor-area Webview Panel: "Tourist Dashboard" (generalized from the Knowledge Map panel)

`knowledge-map/panel.ts`'s singleton-panel pattern (CSP+nonce, `retainContextWhenHidden`, re-render-in-place, `onDidReceiveMessage`) is sound and gets reused, not rewritten. The panel gains a tab strip; existing Knowledge Map HTML becomes one tab's content instead of the whole panel.

- **Tab: Knowledge Map** — exactly today's content (`html.ts`'s rendering, `store.ts`'s forest load/save, the in-webview "Deep Dive on Selected" button wired to `onDeepDive`). No behavior change.
- **Tab: Hook Setup** — install/verify as a persistent view instead of transient info messages: current status, install button, verify button, and (new, UI-only) a short explanation of what Tier 1 coverage means. Calls the existing `installHook`/`verifyHook`/`verifyHookState` functions — no new install/verify logic.
- **Tab: Git Notes Sync** — shows `gitNotesSync` on/off, `gitNotesRemote`, Push/Fetch buttons, and last push/fetch result. Calls the existing `deps.persistence.pushNotes`/`fetchNotes` path via the existing commands (or a thin message-handler wrapper around them, matching how `panel.ts` already wraps `onDeepDive`).
- **Tab: Settings (advanced)** — houses the one custom control that's worth building: an `exclusionPolicy` list editor (add/remove/test-a-pattern-against-the-open-workspace preview), writing back through `vscode.workspace.getConfiguration("tourist").update(...)` — same persistence path `settings.ts` already uses, just with a friendlier input surface than the native array editor. Everything else in this tab is a set of "Open Settings" deep-links (`workbench.action.openSettings` with a filter string), not reimplemented controls — no reason to duplicate `knowledgeMap.claudeBackend`'s enum picker, string inputs, etc. when Settings UI already handles those fine.

Command `tourist.showKnowledgeMap` becomes "open the Dashboard, Knowledge Map tab selected"; `tourist.generateKnowledgeMap` is unchanged (it's a background action, not a view). Both existing commands keep their titles/behavior for Command Palette users.

### C. Native Settings UI — kept as-is for everything except one control

`contributes.configuration` remains the persisted, Settings-Sync-compatible source of truth for all ten settings. No change to `package.json`'s configuration block. The only deviation is that the Dashboard's Settings tab offers a nicer *editor* for `exclusionPolicy` — it reads/writes the same config key, so the native Settings UI entry for it keeps working too (a user could still hand-edit `settings.json` directly and nothing breaks).

## 4. Feature mapping: old surface → new surface

| Feature | Today | Plan |
|---|---|---|
| Toggle tracking/markers | `openMenu` QuickPick or Command Palette | Sidebar Status view (primary) + commands kept (unchanged) |
| Workspace attribution rollup | `explorer` TreeView, `tourist.openWorkspaceView` command, status bar click | Same TreeView, moved into the Tourist Activity Bar container; command/status-bar behavior unchanged |
| Hook install/verify | Command Palette only, transient info/warning messages | Sidebar quick line **and** Dashboard "Hook Setup" tab with persistent status; commands unchanged underneath |
| Git notes push/fetch | Command Palette only, gated on setting | Sidebar quick buttons **and** Dashboard "Git Notes Sync" tab; commands unchanged underneath |
| Knowledge Map generate/show | Two separate Command Palette entries, panel opened via `showKnowledgeMap` | Sidebar entry point + Dashboard's Knowledge Map tab (same panel code); commands unchanged |
| Settings (9 of 10) | Native Settings UI | Unchanged — still native Settings UI |
| `exclusionPolicy` | Native array editor (weak UX) | Native editor still works; Dashboard adds a friendlier list editor over the same key |

## 5. Phased build order (cheapest/highest-value first)

1. **Phase 0 — move, don't build.** Add a `viewsContainers.activitybar` entry and move `tourist.workspaceAttribution` from `views.explorer` into it. Pure `package.json` change, zero TypeScript changes. Immediate discoverability win (the tree view stops being lost inside Explorer) for near-zero risk.
2. **Phase 1 — Sidebar Status webview.** New `WebviewView` provider registered alongside the moved TreeView in the same container. All buttons call *existing* commands/exported functions (`toggleTracking`, `toggleMarkers`, `installHook`, `verifyHook`, `pushAttributionNotes`, `fetchAttributionNotes`, `runGenerateKnowledgeMap`, `showKnowledgeMapPanel`). No new business logic — this phase is UI + message-passing only, following the same `postMessage`/`onDidReceiveMessage` pattern `panel.ts` already establishes.
3. **Phase 2 — Generalize the Knowledge Map panel into the Dashboard.** Add tab chrome to `panel.ts`/`html.ts`; move existing Knowledge Map markup into a tab; add Hook Setup and Git Notes Sync tabs as thin wrappers around existing functions. `tourist.showKnowledgeMap` retargets to "open Dashboard on Knowledge Map tab."
4. **Phase 3 — `exclusionPolicy` custom editor.** Lowest priority: it's one setting, native UI already technically works, and this is pure polish. Build only after Phases 0–2 land and only if it's still felt to be a pain point.
5. **Phase 4 — follow-on settings, if/when they land** (e.g. `knowledgeMap.includePrompts`, or a `deep-dive`/node-re-review command from other in-flight work): surface them inside the Dashboard's Knowledge Map tab next to the Generate button, since they're operationally relevant right before triggering a run — not buried in Settings where they'd be one more undiscovered toggle among ten.

Each phase is independently shippable and backward compatible: every existing command keeps its registered ID and title, so nothing in `keybindings.json`, other extensions, or muscle memory breaks.
