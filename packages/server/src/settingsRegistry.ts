import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LlmClient } from 'vic-requirements-elicitation'

// Mirrors the PluginSettingsManifest/PluginUsage shape every modules/llm/*
// plugin exports (see e.g. modules/llm/glm/src/settingsManifest.ts) —
// duplicated here rather than imported from any one specific plugin
// package, same "no shared package between plugin modules" convention
// those modules already use for their own mirrored types (LlmMessage,
// ChatUsage, PluginUsage, etc.). This keeps settingsRegistry.ts's own type
// resolution independent of whether any particular plugin module happens
// to be present.
export interface PluginSettingOption {
  value: string
  label: string
}

export interface PluginSettingField {
  key: string
  label: string
  description: string
  secret: boolean
  type: 'text' | 'select'
  options?: PluginSettingOption[]
}

export interface PluginSettingsManifest {
  id: string
  label: string
  setupSummary: string
  setupUrl?: string
  fields: PluginSettingField[]
  personaOverridableFields: PluginSettingField[]
}

export interface UsageWindow {
  percentUsed: number
  resetsAt?: string
}

export interface PluginUsage {
  currentWindow?: UsageWindow
  weekly?: UsageWindow
}

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

// Every LLM plugin package lives under modules/llm/* (separate from the
// non-LLM modules/* packages like vic-coding, vic-planning, vic-testing) and
// is discovered here at startup by scanning that folder and dynamically
// importing whatever's actually present — rather than a hardcoded list of
// static imports. Deleting a plugin's folder (or it failing to build) just
// drops it from installedPlugins with a logged warning instead of crashing
// the whole server at module-load time, matching the "optional, checked at
// the edge" convention already used for getUsage above and
// findInstalledPlugin below.
const LLM_MODULES_DIR = path.resolve(fileURLToPath(import.meta.url), '../../../../modules/llm')

interface LlmPluginModule {
  settingsManifest: PluginSettingsManifest
  createClient: (values: Record<string, string>) => LlmClient
  getUsage?: (values: Record<string, string>) => Promise<PluginUsage>
}

function isLlmPluginModule(mod: unknown): mod is LlmPluginModule {
  const m = mod as Partial<LlmPluginModule> | null | undefined
  return (
    !!m &&
    typeof m.settingsManifest === 'object' &&
    m.settingsManifest !== null &&
    typeof m.createClient === 'function'
  )
}

async function discoverLlmPlugins(): Promise<InstalledPlugin[]> {
  let entries: string[]
  try {
    entries = (await readdir(LLM_MODULES_DIR, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch (err) {
    console.warn(`[settingsRegistry] could not read ${LLM_MODULES_DIR}: ${(err as Error).message}`)
    return []
  }

  const plugins: InstalledPlugin[] = []
  for (const dirName of entries) {
    let packageName: string
    try {
      const raw = await readFile(path.join(LLM_MODULES_DIR, dirName, 'package.json'), 'utf-8')
      packageName = JSON.parse(raw).name
    } catch (err) {
      console.warn(
        `[settingsRegistry] skipping modules/llm/${dirName}: couldn't read package.json (${(err as Error).message})`,
      )
      continue
    }

    try {
      const mod: unknown = await import(packageName)
      if (!isLlmPluginModule(mod)) {
        console.warn(
          `[settingsRegistry] skipping ${packageName}: missing settingsManifest/createClient exports`,
        )
        continue
      }
      plugins.push({
        manifest: mod.settingsManifest,
        createClient: mod.createClient,
        getUsage: mod.getUsage,
      })
    } catch (err) {
      console.warn(
        `[settingsRegistry] skipping ${packageName}: failed to load (${(err as Error).message})`,
      )
    }
  }
  return plugins
}

export const installedPlugins: InstalledPlugin[] = await discoverLlmPlugins()

export const installedPluginManifests: PluginSettingsManifest[] = installedPlugins.map(
  (p) => p.manifest,
)

// Plugin ids that are a local CLI subprocess rather than a cloud HTTP API —
// the Settings screen offers a "Check installation" action for these
// (GET /api/settings/plugins/:id/status) since "is it installed" is a
// meaningful, checkable question for a CLI plugin and not for an API-key
// plugin like GLM. PluginSettingsManifest has no field distinguishing
// this (a CLI plugin's manifest looks structurally identical to an
// API-key plugin's), so this stays a fixed list of known CLI-backed ids —
// filtered against installedPluginManifests so an id whose module wasn't
// found simply doesn't appear here, same "discovered, not assumed"
// convention as everything else in this file.
const KNOWN_CLI_BACKED_PLUGIN_IDS = new Set(['vic-llm-claude-code'])
export const CLI_BACKED_PLUGIN_IDS = new Set(
  installedPluginManifests.filter((m) => KNOWN_CLI_BACKED_PLUGIN_IDS.has(m.id)).map((m) => m.id),
)

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

// --- Coding-agent-CLI extras -------------------------------------------
//
// Claude Code and OpenCode are also file-editing agent CLIs (used by the
// Dev/QA personas' Coding stage, not just chat), which is capability the
// generic InstalledPlugin shape above doesn't model. Rather than have
// index.ts statically `import ... from 'vic-llm-claude-code'` /
// 'vic-llm-opencode' (the exact hardcoded coupling that made deleting
// either module crash the server on boot), these are loaded once here,
// the same guarded way as discoverLlmPlugins, and exposed as `| undefined`
// so a missing module just means that one coding-agent backend, and
// anything depending on it (e.g. the GLM Dev persona needing OpenCode),
// is unavailable rather than fatal.
async function loadOptional<T>(packageName: string): Promise<T | undefined> {
  try {
    return (await import(packageName)) as T
  } catch (err) {
    console.warn(`[settingsRegistry] optional module unavailable: ${packageName} (${(err as Error).message})`)
    return undefined
  }
}

const claudeCodeModule = await loadOptional<typeof import('vic-llm-claude-code')>('vic-llm-claude-code')
const openCodeModule = await loadOptional<typeof import('vic-llm-opencode')>('vic-llm-opencode')
const glmModule = await loadOptional<typeof import('vic-llm-glm')>('vic-llm-glm')

export const codingAgentClient = claudeCodeModule ? new claudeCodeModule.ClaudeCodeAgentClient() : undefined
export const openCodeAgentClient = openCodeModule ? new openCodeModule.OpenCodeAgentClient() : undefined

export async function checkClaudeCodeInstalled(): Promise<
  import('vic-llm-claude-code').ClaudeCodeInstallStatus
> {
  if (!claudeCodeModule) {
    return { installed: false, error: 'vic-llm-claude-code plugin module is not installed' }
  }
  return claudeCodeModule.checkClaudeCodeInstalled()
}

export const GlmApiError = glmModule?.GlmApiError
export const resolveGlmBaseUrl = glmModule?.resolveGlmBaseUrl
