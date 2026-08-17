import {
  settingsManifest as glmSettingsManifest,
  createClient as createGlmClient,
  getUsage as getGlmUsage,
} from 'vic-llm-glm'
import type { PluginSettingsManifest, PluginUsage } from 'vic-llm-glm'
import {
  settingsManifest as claudeCodeSettingsManifest,
  createClient as createClaudeCodeClient,
  getUsage as getClaudeCodeUsage,
} from 'vic-llm-claude-code'
import type { LlmClient } from 'vic-requirements-elicitation'

export interface InstalledPlugin {
  manifest: PluginSettingsManifest
  // Turns this plugin's saved settings values into a working LlmClient.
  // The application layer calls this without knowing the plugin's own
  // constructor shape — that mapping lives in the plugin module itself.
  createClient: (values: Record<string, string>) => LlmClient
  // Fetches this plugin's current rate-limit/quota usage (e.g. Claude
  // Code's 5-hour/weekly Pro/Max plan windows, GLM's Coding Plan token
  // windows), for the status bar. Optional — a plugin that has no
  // provider-side quota concept (or hasn't implemented the lookup yet)
  // simply doesn't export one, and the server treats it as "unavailable"
  // rather than an error.
  getUsage?: (values: Record<string, string>) => Promise<PluginUsage>
}

// Every installed LLM plugin is listed here. Adding a new provider is:
// (1) a new modules/llm-x package exporting settingsManifest + createClient
// the same shape as these two, (2) one entry pushed onto this array. No
// other server route or UI change is needed — SettingsScreen renders
// generically from installedPluginManifests, and every persona's plugin
// dropdown is populated from the same list.
export const installedPlugins: InstalledPlugin[] = [
  { manifest: glmSettingsManifest, createClient: createGlmClient, getUsage: getGlmUsage },
  {
    manifest: claudeCodeSettingsManifest,
    createClient: createClaudeCodeClient,
    getUsage: getClaudeCodeUsage,
  },
]

export const installedPluginManifests: PluginSettingsManifest[] = installedPlugins.map(
  (p) => p.manifest,
)

// Plugin ids that are a local CLI subprocess rather than a cloud HTTP API —
// the Settings screen offers a "Check installation" action for these
// (GET /api/settings/plugins/:id/status) since "is it installed" is a
// meaningful, checkable question for a CLI plugin and not for an API-key
// plugin like GLM.
export const CLI_BACKED_PLUGIN_IDS = new Set([claudeCodeSettingsManifest.id])

export interface PersonaInfo {
  id: string
  label: string
  // Plugin this persona uses if the user hasn't picked one yet in Settings
  // > Personas. The user's actual choice (if any) is stored separately in
  // persona-settings.json and always takes priority — see
  // resolvePersonaPluginId in packages/server/src/index.ts. null means
  // "no built-in default"; the persona still shows up in Settings so the
  // user can assign any installed plugin to it.
  defaultPluginId: string | null
  // Whether this persona exposes a second, optional "agent" model level
  // that its master model can delegate scoped sub-tasks to (see
  // resolvePersonaAgentPluginId in index.ts). Only Dev's coding work is
  // multi-file/tool-using/long-running enough to benefit from delegation
  // today — Analyst/Architect/PM/Code Gap Scan/QA are single-shot
  // document-producing calls with nothing to delegate. Settings > Personas
  // only renders the agent-level dropdown when this is true.
  supportsAgentLevel: boolean
}

// One entry per persona (req 60), independent of which stages are
// actually implemented yet — only 'analyst' and 'architect' call an LLM
// today.
export const personas: PersonaInfo[] = [
  { id: 'analyst', label: 'Analyst (Requirements)', defaultPluginId: 'vic-llm-glm', supportsAgentLevel: false },
  { id: 'architect', label: 'Architect (Architecture)', defaultPluginId: 'vic-llm-glm', supportsAgentLevel: false },
  // Separate from 'analyst' even though both are requirements-stage work:
  // this is its own user-triggered action (Import Project's "Scan Code for
  // Requirement Gaps" button) with its own LLM cost, scanning source files
  // rather than reviewing requirement text — worth letting the user pick a
  // different/cheaper model for it independently of the Analyst persona.
  { id: 'code-gap-scan', label: 'Code Gap Scan (Import)', defaultPluginId: 'vic-llm-glm', supportsAgentLevel: false },
  { id: 'pm', label: 'PM (Planning)', defaultPluginId: null, supportsAgentLevel: false },
  { id: 'dev', label: 'Dev (Coding)', defaultPluginId: null, supportsAgentLevel: true },
  { id: 'qa', label: 'QA (Test Creation/Execution)', defaultPluginId: null, supportsAgentLevel: false },
]

export function findPluginManifest(pluginId: string): PluginSettingsManifest | undefined {
  return installedPluginManifests.find((m) => m.id === pluginId)
}

export function findInstalledPlugin(pluginId: string): InstalledPlugin | undefined {
  return installedPlugins.find((p) => p.manifest.id === pluginId)
}
