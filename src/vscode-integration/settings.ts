/**
 * Typed accessors for every `tourist.*` setting this project introduces.
 * Kept as one small module (rather than scattering `getConfiguration` calls
 * across decorations/status-bar/commands) so a setting's key and default
 * live in exactly one place.
 *
 * Naming notes, flagged for the final report -- neither PLAN1.md's Part 2
 * contract nor GOAL1.md pins down every setting's exact key:
 * - `showAttributionMarkers` (not tourist-raw's `showAiMarkers`, carried
 *   forward unchanged): renamed because this toggle now hides/shows all
 *   three decoration types, not just the "ai" one, and keeping the old key
 *   would be actively misleading, not just an unrelated rename.
 * - `shareAttribution` matches GOAL1.md's locked-scope naming
 *   (`tourist.shareAttribution`, GOAL1.md line ~103) rather than PLAN1.md
 *   Part 2's `tourist.gitNotesSync` -- the two documents name this same
 *   toggle differently; GOAL1.md is treated as authoritative since it's the
 *   locked-scope document, but Agent B (who owns the toggle's actual read
 *   side) should confirm the key name before Sync point 2.
 * - `gitNotesRemote` and `exclusionPolicy` are Agent C's own additions --
 *   neither document specifies how "push to a named remote" names that
 *   remote, or how the exclusion-policy override's extra patterns are
 *   actually threaded into Agent A's `createExclusionPredicate`.
 */
import * as vscode from "vscode";

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("tourist");
}

export function isTrackingEnabled(): boolean {
  return config().get<boolean>("attributionTracking", true);
}

export function setTrackingEnabled(value: boolean): Thenable<void> {
  return config().update("attributionTracking", value, vscode.ConfigurationTarget.Global);
}

export function showAttributionMarkers(): boolean {
  return config().get<boolean>("showAttributionMarkers", true);
}

export function setShowAttributionMarkers(value: boolean): Thenable<void> {
  return config().update("showAttributionMarkers", value, vscode.ConfigurationTarget.Global);
}

export function attributionRetentionDays(): number {
  return config().get<number>("attributionRetentionDays", 3);
}

export function exclusionPolicyOverride(): string[] {
  return config().get<string[]>("exclusionPolicy", []);
}

export function isShareAttributionEnabled(): boolean {
  return config().get<boolean>("shareAttribution", false);
}

export function gitNotesRemote(): string {
  return config().get<string>("gitNotesRemote", "origin");
}

export const RELEVANT_CONFIG_KEYS = [
  "tourist.attributionTracking",
  "tourist.showAttributionMarkers",
  "tourist.attributionRetentionDays",
  "tourist.exclusionPolicy",
  "tourist.shareAttribution",
  "tourist.gitNotesRemote",
] as const;

export function affectsTouristConfig(event: vscode.ConfigurationChangeEvent): boolean {
  return RELEVANT_CONFIG_KEYS.some((key) => event.affectsConfiguration(key));
}
