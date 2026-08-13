/**
 * Pure string transforms over ideation/knowledge-forest/ui/knowledge-forest.html's
 * *content* -- this module never writes to that file. Scope explicitly
 * excludes touching ideation/knowledge-forest/ internals, and that file's
 * demo data + lack of any vscode.postMessage wiring means the loader/wiring
 * it needs (per its own PLAN.md "Not built yet" section) has to be layered
 * on from outside, at render time, in this extension's own code.
 *
 * Three transforms, applied in order by buildKnowledgeMapHtml:
 *  1. injectRealForestData -- replaces the three hardcoded demo arrays with
 *     the real persisted forest, anchored on stable substrings so a small
 *     upstream formatting change degrades to "keep demo data for that
 *     section" instead of producing broken HTML.
 *  2. injectContentSecurityPolicy -- adds a nonce'd CSP <meta> and nonces
 *     the original inline <script> tag.
 *  3. injectOverrideBridge -- appends a second nonce'd <script> that wires
 *     the existing confirm/reject/rename/addChild/delete/dot actions to
 *     vscode.postMessage, purely by DOM inspection (see its header comment
 *     for why that's possible without touching the original script), plus
 *     a checkbox multi-select + "Deep Dive on Selected" affordance, plus a
 *     "Re-review" affordance on confirmed/gap nodes specifically (see
 *     buildProvenanceIndex below for why the bridge needs its own
 *     provenance lookup to tell those nodes apart from "tracked" ones,
 *     which render identically in the DOM).
 */
import * as crypto from "node:crypto";
import { emptyForest } from "./types.ts";
import type { ForestFile, ForestKind, ForestNode, Provenance } from "./types.ts";

export function makeNonce(): string {
  return crypto.randomBytes(16).toString("base64");
}

interface UiNode extends Omit<ForestNode, "children" | "latent"> {
  children: UiNode[];
  latent: UiNode[];
  expanded: boolean;
}

function hydrate(nodes: ForestNode[]): UiNode[] {
  return nodes.map((n) => ({
    ...n,
    expanded: true,
    children: hydrate(n.children),
    latent: hydrate(n.latent),
  }));
}

const SECTION_ANCHORS: Record<ForestKind, { varName: string; start: string; end: string }> = {
  tech: { varName: "techForestData", start: "var techForestData = [", end: "\n\n  var csForestData" },
  cs: { varName: "csForestData", start: "var csForestData = [", end: "\n\n  var practiceForestData" },
  practice: {
    varName: "practiceForestData",
    start: "var practiceForestData = [",
    end: "\n\n  // ---------------- rendering",
  },
};

/**
 * ui/knowledge-forest.html's own `mkNode` also assigns an `id` -- omitted
 * here since the rendering code only reads `id` for `data-id` attributes
 * used to dispatch actions back into its own closures, which is exactly the
 * "existing" behavior we leave untouched. The bridge script (below) never
 * relies on `id` at all, precisely because it isn't stable/meaningful
 * outside a single page load -- it derives node identity from rendered
 * label text instead.
 */
function replaceSection(html: string, kind: ForestKind, data: UiNode[]): string {
  const { varName, start, end } = SECTION_ANCHORS[kind];
  const startIdx = html.indexOf(start);
  if (startIdx === -1) return html;
  const endIdx = html.indexOf(end, startIdx);
  if (endIdx === -1) return html;
  const replacement = `var ${varName} = ${JSON.stringify(data)};`;
  return html.slice(0, startIdx) + replacement + html.slice(endIdx);
}

/**
 * Maps every node's `kind|["path","segments"]` key (same encoding
 * decorateRow's checkbox `selections` map already uses, and the same one
 * forest/merge.ts's --reopen matching keys off of on the analyser side) to
 * its stored provenance. ui/knowledge-forest.html's own renderRow only ever
 * adds a DOM class for "ai" (`.prov-ai`) and "gap" (`.prov-gap`) -- there is
 * no `.prov-confirmed`/`.prov-tracked`, so "confirmed" and "tracked" nodes
 * are visually and structurally identical in the rendered DOM. The bridge
 * script can't tell them apart by inspection alone, which matters because
 * the "Re-review" affordance must appear on confirmed/gap nodes only, never
 * on tracked ones. This index is computed here (where the real ForestFile
 * is still available) and inlined into the bridge script as data, the same
 * way injectRealForestData inlines the forest itself for the original
 * script.
 */
function buildProvenanceIndex(forest: ForestFile): Record<string, Provenance> {
  const index: Record<string, Provenance> = {};
  const kinds: ForestKind[] = ["tech", "cs", "practice"];
  const walk = (nodes: ForestNode[], kind: ForestKind, parentPath: string[]): void => {
    for (const n of nodes) {
      const path = [...parentPath, n.label];
      index[`${kind}|${JSON.stringify(path)}`] = n.provenance;
      walk(n.children, kind, path);
      walk(n.latent, kind, path);
    }
  };
  for (const kind of kinds) walk(forest[kind], kind, []);
  return index;
}

export function injectRealForestData(html: string, forest: ForestFile): string {
  let out = html;
  out = replaceSection(out, "tech", hydrate(forest.tech));
  out = replaceSection(out, "cs", hydrate(forest.cs));
  out = replaceSection(out, "practice", hydrate(forest.practice));
  return out;
}

/**
 * ui/knowledge-forest.html's `<html>` tag hardcodes `data-theme="light"` as
 * its initial value -- fine for a standalone page load, but panel.ts's
 * `render()` calls `buildKnowledgeMapHtml` again (from that same on-disk
 * raw file) after every node-override/deep-dive round trip, replacing
 * `panel.webview.html` wholesale. Without this, each of those re-renders
 * silently drops whatever theme the user had live-selected back to the
 * file's hardcoded default. Only touches the first `<html ...>` tag's
 * `data-theme` attribute, so it's independent of the other anchor-based
 * transforms above.
 */
export function injectTheme(html: string, theme: string | undefined): string {
  if (!theme) return html;
  return html.replace(/<html([^>]*)\bdata-theme="[^"]*"/, `<html$1data-theme="${theme}"`);
}

export function injectContentSecurityPolicy(html: string, nonce: string, cspSource: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">`;
  const withMeta = html.includes("</head>") ? html.replace("</head>", `${meta}\n</head>`) : meta + html;
  // Exactly one un-attributed `<script>` tag exists in the source file (the
  // demo IIFE) -- nonce it so it still runs under the CSP above.
  return withMeta.replace("<script>", `<script nonce="${nonce}">`);
}

/**
 * The bridge script below never reads any of the original script's private
 * `data`/`createForest` closures -- it can't; they're not exposed on
 * `window`. Instead it derives a node's identity from the *rendered DOM*:
 * each `.node-row`'s `.label` text, walked up through ancestor `<li>`s to
 * the enclosing `.stack-card`'s root row, reconstructs the exact label path
 * mergeForest.ts already matches nodes by. That also means it's naturally
 * robust to the original script's internal `id` values being page-load-
 * ephemeral (`nextId` resets to 1000 on every reload).
 *
 * Ordering: this script is appended just before `</body>`, i.e. it always
 * runs *after* the original inline script has defined `createForest` and
 * attached its own listeners to `#forest-tech`/`#forest-cs`/`#forest-practice`
 * and the three "+ Add ..." buttons. Multiple listeners on the same element
 * for the same event fire in registration order, so every listener this
 * script adds on those same elements is guaranteed to run *after* the
 * original's -- i.e. after any mutation, `window.prompt`/`window.confirm`
 * dialog, and `render()` call the click triggered. `window.prompt` and
 * `window.confirm` are monkey-patched so this script can observe what the
 * user actually typed/decided, since the click handler that calls them is
 * the original (un-modified) one.
 */
function buildOverrideBridgeSource(provenanceIndexJson: string): string {
  return `
(function () {
  // Guarded behind a window-level singleton because panel.ts's dashboard
  // chrome (dashboard-tabs.ts's TAB_SWITCH_SCRIPT) shares this same document
  // and also needs a vscode API handle -- acquireVsCodeApi() throws if
  // called twice in one webview, so whichever script runs first wins and
  // the other reuses it.
  var vscodeApi = window.__touristVscodeApi || (window.__touristVscodeApi = acquireVsCodeApi());
  // kind|["path","segments"] -> provenance, built server-side by
  // buildProvenanceIndex since the DOM alone can't distinguish "confirmed"
  // from "tracked" -- see this module's header comment.
  var PROVENANCE_INDEX = ${provenanceIndexJson};

  var lastPromptValue = null;
  var nativePrompt = window.prompt;
  window.prompt = function (message, def) {
    lastPromptValue = nativePrompt.call(window, message, def);
    return lastPromptValue;
  };

  var lastConfirmValue = true;
  var nativeConfirm = window.confirm;
  window.confirm = function (message) {
    lastConfirmValue = nativeConfirm.call(window, message);
    return lastConfirmValue;
  };

  function post(msg) {
    vscodeApi.postMessage(msg);
  }

  function countFilledDots(row) {
    return row.querySelectorAll(".dots .dot.filled").length;
  }

  // Reconstructs the label path from the forest root down to \`row\`, purely
  // from rendered text -- see this module's header comment for why.
  function pathFromRow(row) {
    if (row.classList.contains("is-root")) {
      var rootLabel = row.querySelector(".label");
      return rootLabel ? [rootLabel.textContent] : [];
    }
    var path = [];
    var li = row.closest("li");
    while (li) {
      var ownRow = li.querySelector(":scope > .node-row");
      var lbl = ownRow ? ownRow.querySelector(".label") : null;
      if (lbl) path.unshift(lbl.textContent);
      var ul = li.parentElement;
      var container = ul ? ul.parentElement : null;
      if (container && container.classList && container.classList.contains("stack-card")) {
        var rootLbl = container.querySelector(":scope > .node-row.is-root > .label");
        if (rootLbl) path.unshift(rootLbl.textContent);
        li = null;
      } else if (container && container.tagName === "LI") {
        li = container;
      } else {
        li = null;
      }
    }
    return path;
  }

  function wireForest(forestElId, kind) {
    var el = document.getElementById(forestElId);
    if (!el) return;

    el.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-action]");
      if (!btn) return;
      var action = btn.getAttribute("data-action");
      var row = btn.closest(".node-row");
      if (!row) return;
      var path = pathFromRow(row);
      if (path.length === 0) return;

      if (action === "confirm") {
        var current = countFilledDots(row);
        post({ type: "nodeOverride", forest: kind, path: path, action: "confirm", value: current > 0 ? current : 2 });
      } else if (action === "reject") {
        post({ type: "nodeOverride", forest: kind, path: path, action: "reject" });
      } else if (action === "dot") {
        post({ type: "nodeOverride", forest: kind, path: path, action: "proficiency", value: Number(btn.getAttribute("data-value")) });
      } else if (action === "rename") {
        if (lastPromptValue) post({ type: "nodeOverride", forest: kind, path: path, action: "rename", value: lastPromptValue });
      } else if (action === "addchild") {
        if (lastPromptValue) post({ type: "nodeOverride", forest: kind, path: path, action: "addChild", value: lastPromptValue });
      } else if (action === "delete" || action === "deletestack") {
        if (lastConfirmValue) post({ type: "nodeOverride", forest: kind, path: path, action: "delete" });
      }
      lastPromptValue = null;
    });

    var addBtn = document.getElementById("addStackBtn-" + kind);
    if (addBtn) {
      addBtn.addEventListener("click", function () {
        if (lastPromptValue) post({ type: "nodeOverride", forest: kind, path: [], action: "addChild", value: lastPromptValue });
        lastPromptValue = null;
      });
    }
  }

  ["tech", "cs", "practice"].forEach(function (kind) {
    wireForest("forest-" + kind, kind);
  });

  // ---- Deep-dive multi-select -------------------------------------------
  // Injects a checkbox into every rendered node row and a floating
  // "Deep Dive on Selected" bar. Rows get fully rebuilt by the original
  // script's render() on every action, so a MutationObserver re-decorates
  // after every rebuild rather than assuming the checkbox survives.
  var selections = new Map();

  function updateDeepDiveBar() {
    var n = selections.size;
    deepDiveCount.textContent = n + (n === 1 ? " topic selected" : " topics selected");
    deepDiveBtn.disabled = n === 0;
  }

  function decorateRow(row, kind) {
    if (row.querySelector(".km-select-checkbox")) return;
    var cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "km-select-checkbox";
    cb.title = "Select for deep dive";
    cb.style.marginRight = "4px";
    cb.addEventListener("click", function (ev) {
      ev.stopPropagation();
    });
    cb.addEventListener("change", function () {
      var path = pathFromRow(row);
      if (path.length === 0) return;
      var key = kind + "|" + JSON.stringify(path);
      if (cb.checked) selections.set(key, path[path.length - 1]);
      else selections.delete(key);
      updateDeepDiveBar();
    });
    row.insertBefore(cb, row.firstChild);

    // ---- Re-review affordance (confirmed/gap nodes only) ------------------
    // Explicit, one-time opt-in per node -- see types.ts's ReopenNodeMessage.
    // Not shown for "ai" (already has confirm/reject) or "tracked" (already
    // updates every run) -- only for "confirmed"/"gap", which PROVENANCE_INDEX
    // is needed to tell apart from "tracked" (see this module's header
    // comment on buildProvenanceIndex).
    var path = pathFromRow(row);
    if (path.length > 0) {
      var provenance = PROVENANCE_INDEX[kind + "|" + JSON.stringify(path)];
      if (provenance === "confirmed" || provenance === "gap") {
        var reopenBtn = document.createElement("button");
        reopenBtn.className = "icon-btn km-reopen-btn";
        reopenBtn.type = "button";
        reopenBtn.title = "Re-review: ask Claude to re-assess this node on the next run only (does not unfreeze it permanently)";
        reopenBtn.textContent = "\u{1F501}";
        reopenBtn.addEventListener("click", function (ev) {
          ev.stopPropagation();
          var label = path[path.length - 1];
          if (label) post({ type: "reopenNode", topic: label });
        });
        var actionsEl = row.querySelector(".row-actions");
        if (actionsEl) actionsEl.appendChild(reopenBtn);
        else row.appendChild(reopenBtn);
      }
    }
  }

  function decorateAll() {
    ["tech", "cs", "practice"].forEach(function (kind) {
      var el = document.getElementById("forest-" + kind);
      if (!el) return;
      el.querySelectorAll(".node-row").forEach(function (row) {
        decorateRow(row, kind);
      });
    });
  }

  ["forest-tech", "forest-cs", "forest-practice"].forEach(function (id) {
    var el = document.getElementById(id);
    if (!el) return;
    new MutationObserver(decorateAll).observe(el, { childList: true, subtree: true });
  });
  decorateAll();

  var deepDiveBar = document.createElement("div");
  deepDiveBar.style.cssText =
    "position:fixed;bottom:16px;right:16px;background:var(--surface-1);border:1px solid var(--border);" +
    "border-radius:8px;padding:10px 14px;box-shadow:0 2px 8px rgba(0,0,0,.2);z-index:9999;font-size:12.5px;" +
    "color:var(--text-primary);display:flex;align-items:center;gap:10px;font-family:inherit;";
  var deepDiveCount = document.createElement("span");
  var deepDiveBtn = document.createElement("button");
  deepDiveBtn.type = "button";
  deepDiveBtn.textContent = "Deep Dive on Selected";
  deepDiveBtn.disabled = true;
  deepDiveBtn.style.cssText =
    "font-weight:600;border:1px solid var(--border);border-radius:6px;padding:6px 10px;cursor:pointer;" +
    "background:var(--surface-1);color:var(--text-primary);";
  deepDiveBtn.addEventListener("click", function () {
    if (selections.size === 0) return;
    post({ type: "deepDive", topics: Array.from(selections.values()) });
  });
  deepDiveBar.appendChild(deepDiveCount);
  deepDiveBar.appendChild(deepDiveBtn);
  document.body.appendChild(deepDiveBar);
  updateDeepDiveBar();

  // ---- Theme persistence --------------------------------------------------
  // The original script's own themeSelect listener (registered before this
  // bridge script runs, so it always fires first -- see this module's
  // header comment on registration order) only updates the live DOM. It
  // has no way to reach the extension host, so a theme choice would
  // otherwise be silently lost the next time panel.ts calls
  // buildKnowledgeMapHtml and replaces the whole document (after any
  // nodeOverride or deepDive round trip). Report every change so the
  // extension host can carry it forward into the next render.
  var themeSelectEl = document.getElementById("themeSelect");
  if (themeSelectEl) {
    themeSelectEl.addEventListener("change", function () {
      post({ type: "themeChanged", theme: themeSelectEl.value });
    });
  }
})();
`;
}

export function injectOverrideBridge(html: string, nonce: string, forest: ForestFile = emptyForest()): string {
  const provenanceIndexJson = JSON.stringify(buildProvenanceIndex(forest));
  const bridge = `<script nonce="${nonce}">${buildOverrideBridgeSource(provenanceIndexJson)}</script>`;
  return html.includes("</body>") ? html.replace("</body>", `${bridge}\n</body>`) : html + bridge;
}

export function buildKnowledgeMapHtml(
  rawHtml: string,
  forest: ForestFile,
  cspSource: string,
  theme?: string,
  nonce: string = makeNonce()
): string {
  let html = injectRealForestData(rawHtml, forest);
  html = injectTheme(html, theme);
  html = injectContentSecurityPolicy(html, nonce, cspSource);
  html = injectOverrideBridge(html, nonce, forest);
  return html;
}
