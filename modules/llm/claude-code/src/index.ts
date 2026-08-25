export type {
  LlmRole,
  LlmMessage,
  ChatOptions,
  ChatResult,
  ChatUsage,
  ClaudeCodeChatClient,
} from './ClaudeCodeClient.js'
export { ClaudeCodeCliClient, ClaudeCodeCliError } from './ClaudeCodeCliClient.js'
export type { ClaudeCodeCliClientOptions } from './ClaudeCodeCliClient.js'
export { createClient } from './createClient.js'
export { checkClaudeCodeInstalled } from './checkInstalled.js'
export type { ClaudeCodeInstallStatus } from './checkInstalled.js'
export {
  settingsManifest,
  KNOWN_CLAUDE_CODE_MODELS,
  EFFORT_OPTIONS,
} from './settingsManifest.js'
export type {
  PluginSettingField,
  PluginSettingOption,
  PluginSettingsManifest,
} from './settingsManifest.js'
export { getUsage, ClaudeCodeUsageError, __setCredentialsPathForTests } from './getUsage.js'
export type { PluginUsage, UsageWindow } from './PluginUsage.js'
export { ClaudeCodeAgentClient, ClaudeCodeAgentError } from './ClaudeCodeAgentClient.js'
export type {
  AgentRunOptions,
  AgentRunResult,
  AgentChatUsage,
  AgentRunTiming,
  AgentProviderId,
} from './ClaudeCodeAgentClient.js'
