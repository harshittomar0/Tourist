# Tourist

**Live, per-line attribution of who — or what — wrote each line in your workspace: Claude Code, you, or something else.**

Tourist watches your files as you work and colors every line by where it came from. It's built for one specific problem: when a line changes on disk and you didn't type it, most tools just assume "AI did it." Tourist doesn't guess — if it can't prove a change came from Claude Code, it marks it **external/unknown** instead of silently calling it AI.

<!-- TODO screenshot: hero shot — an editor with a mix of blue/orange/dashed-magenta decorated lines. Manual capture: open a file with AI, human, and formatter-driven edits, screenshot the gutter. -->

## How attribution works

Every line ends up in one of three buckets, decided by how much evidence Tourist actually has:

- **AI** (blue) — Claude Code told Tourist it made this edit. Tourist installs a hook into Claude Code's `PreToolUse`/`PostToolUse` events (for `Edit`, `Write`, and `MultiEdit` tool calls), so this is a direct, ground-truth signal, not a guess. Lines where Claude Code wrote to disk but the hook signal was missing can still land here if Tourist finds corroborating evidence — e.g. Claude Code's own IDE lock file, or a shell/process trail — but with lower confidence than the direct hook signal.
- **Human** (orange) — You typed it. If the file was already "dirty" (had unsaved changes) right before and after the edit, Tourist knows it came from typing in the editor, not from Claude Code or another tool.
- **External / unknown** (dashed magenta, with a `?` icon) — Something wrote to disk and Tourist has no evidence it was Claude Code: a formatter, another tool, another AI, a Git operation, or anything else. This is the deliberate honest-uncertainty bucket — Tourist never defaults an unexplained change to "AI."

Lines nobody has touched yet (the checked-in baseline) aren't decorated at all.

## Features

### Gutter / line decorations

Every attributed line gets a colored left-edge marker in the editor gutter (`src/vscode-integration/decorations.ts`):

| Attribution | Style | Color |
|---|---|---|
| AI | solid border | blue (`#3b82f6`) |
| Human | solid border | orange (`#f0883e`) |
| External / unknown | **dashed** border + `?` gutter icon | magenta (`#c026d3`) |

Hovering a decorated line shows a tooltip ("Tourist: written by Claude Code" / "written by you" / "written by something else"). Decorations update live as you open files, switch editors, type, save, and whenever a Tourist setting changes.

<!-- TODO screenshot: close-up of the gutter showing all three decoration styles side by side, with one tooltip open on hover. -->

### Status bar rollup

A status bar item (bottom right) shows the workspace-wide attribution split as a percentage — e.g. `Tourist: 40% AI, 45% human, 15% external`. Click it to open the Workspace Attribution view.

<!-- TODO screenshot: status bar item with a real percentage breakdown visible. -->

### Explorer "Attribution" view

A tree view named **Attribution**, nested under the built-in Explorer panel (not its own activity-bar icon). It rolls up attribution stats folder → file, so you can see which parts of the workspace are mostly AI-written vs. human-written vs. unknown at a glance.

<!-- TODO screenshot: Explorer sidebar expanded with the Attribution view showing a folder/file tree and stats. -->

### Commands

All available from the Command Palette, or via the telescope icon (**Tourist: Open Menu**) in the editor title bar:

| Command | What it does |
|---|---|
| `Tourist: Open Menu` | Quick-pick menu of Tourist actions |
| `Tourist: Toggle Attribution Tracking` | Turn recording on/off (existing markers are kept, nothing new is saved while off) |
| `Tourist: Toggle Attribution Line Markers` | Show/hide the gutter decorations without affecting recording |
| `Tourist: Install Claude Code Hook` | Installs the `PreToolUse`/`PostToolUse` hook Tourist needs for ground-truth AI detection |
| `Tourist: Verify Claude Code Hook` | Checks that the hook is installed and pointing at the right script |
| `Tourist: Open Workspace Attribution View` | Opens/focuses the Attribution sidebar view |
| `Tourist: Push Attribution Notes` | Pushes local attribution history to `refs/notes/tourist-attribution` on the configured remote (requires `tourist.gitNotesSync`) |
| `Tourist: Fetch Attribution Notes` | Fetches and merges attribution history from the remote (requires `tourist.gitNotesSync`) |

### Settings

| Setting | Default | What it does |
|---|---|---|
| `tourist.attributionTracking` | `true` | Record AI/human/external attribution as you edit. Off = existing markers stay frozen, nothing new is recorded. |
| `tourist.showAttributionMarkers` | `true` | Show the gutter decorations. Off hides them without affecting recording. |
| `tourist.attributionRetentionDays` | `3` | How many days a file's attribution markers survive across restarts before aging out. |
| `tourist.exclusionPolicy` | `[]` | Extra gitignore-style globs to exclude, on top of `.gitignore` and built-in defaults (`node_modules/`, build output, `.git/`). |
| `tourist.gitNotesSync` | `false` | Off by default — no network calls at all. When on, Push/Fetch Attribution Notes sync `refs/notes/tourist-attribution` with a remote so a team can share attribution history. |
| `tourist.gitNotesRemote` | `"origin"` | The git remote used by Push/Fetch, when `gitNotesSync` is on. |

### Dual persistence

Tourist saves attribution history two ways:

- **Local (always on, default)** — every workspace's attribution history is written to a JSON file in VS Code's global storage, keyed by repo path and branch. Entries are keyed by a **content hash**, not file path, so attribution survives file renames. Writes are atomic. This works with zero configuration and never touches the network.
- **Git notes (opt-in)** — set `tourist.gitNotesSync` to `true` to enable syncing attribution history as git notes (`refs/notes/tourist-attribution`) so a team can share it. Syncing is entirely manual: run **Tourist: Push Attribution Notes** or **Tourist: Fetch Attribution Notes** yourself. There's no automatic sync on commit — nothing goes over the network unless you run one of those two commands with the setting enabled.

## Requirements

- VS Code `^1.85.0`
- For building from source: Node.js `>=18`
- [Claude Code](https://claude.com/claude-code) CLI, with the Tourist hook installed via **Tourist: Install Claude Code Hook**, for the ground-truth AI signal

## Development

```bash
npm install
npm run build      # one-off esbuild bundle
npm run watch       # rebuild on change
npm test            # vitest
```

Press `F5` in VS Code to launch an Extension Development Host with Tourist loaded (see `.vscode/launch.json`).

<!-- TODO screenshot: Command Palette filtered to "Tourist:" showing the full command list. -->
