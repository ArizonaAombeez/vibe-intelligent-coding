// Generic quota-usage shape any LLM plugin can optionally report, so the
// server/UI can render a status-bar usage bar without knowing which
// provider is behind it. Mirrors the settingsManifest pattern (each plugin
// exports the same shape independently) rather than a shared package,
// since this repo has no shared-types package between plugin modules yet.

export interface UsageWindow {
  // 0-100. Provider-reported; not derived from VIC's own token counting.
  percentUsed: number
  // ISO 8601 timestamp of when this window resets. Undefined if the
  // provider didn't report one.
  resetsAt?: string
}

export interface PluginUsage {
  // Rolling short window (Claude Code: 5-hour session window; GLM: 5-hour
  // token window). Undefined if the provider doesn't expose this window.
  currentWindow?: UsageWindow
  // Rolling weekly window. Undefined if the provider doesn't expose it.
  weekly?: UsageWindow
}
