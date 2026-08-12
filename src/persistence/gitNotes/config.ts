export interface AttributionSharingConfig {
  /** Off by default. Mode B does nothing — no git-notes I/O of any kind — until this is true. */
  enabled: boolean;
  remote?: string;
}

export const DEFAULT_ATTRIBUTION_SHARING_CONFIG: AttributionSharingConfig = {
  enabled: false,
  remote: "origin"
};

export function isAttributionSharingEnabled(config: AttributionSharingConfig): boolean {
  return config.enabled === true;
}
