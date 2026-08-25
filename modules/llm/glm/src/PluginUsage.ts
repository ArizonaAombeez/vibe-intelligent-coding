// Generic quota-usage shape any LLM plugin can optionally report, so the
// server/UI can render a status-bar usage bar without knowing which
// provider is behind it. Mirrors vic-llm-claude-code's PluginUsage.ts —
// duplicated rather than shared, same as this repo's other cross-plugin
// type mirrors (LlmMessage, ChatUsage, etc.), since there is no shared
// package between plugin modules yet.

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
