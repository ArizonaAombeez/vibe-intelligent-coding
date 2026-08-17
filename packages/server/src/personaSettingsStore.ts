import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

// Non-secret per-persona settings (which plugin backs it, plus field
// overrides like model/thinking choice) — kept in a separate file from
// secrets.json since these aren't credentials, just local-machine
// preferences. Keyed by persona id -> field key -> value. The plugin
// selection is stored under the reserved key below, alongside the plugin's
// own personaOverridableFields — one file, one generic key-value shape, so
// wiring PM/Dev/QA later needs no schema change.
export type PersonaSettingsData = Record<string, Record<string, string>>

// Two independent copies of PersonaSettingsData: 'admin' backs the pipeline
// when an admin is running it, 'user' backs it for everyone else. Admins
// can view and edit both; regular users can only view (never edit) 'user'
// — enforced by the routes in index.ts, not this store. Kept as two scopes
// inside one file (rather than two files) so both lists are always read/
// written together and can never partially exist.
export type PersonaScope = 'admin' | 'user'

type ScopedPersonaSettingsData = Record<PersonaScope, PersonaSettingsData>

// Reserved field key (can't collide with a plugin's own field keys, which
// are always unprefixed identifiers like "model"/"thinking") holding the
// user's chosen plugin id for a persona, when they've overridden the
// built-in default from settingsRegistry.ts.
export const PLUGIN_ID_KEY = '__pluginId'

// Second, independent reserved key holding the plugin id for a persona's
// optional "agent" level — a second model the persona's master model can
// delegate scoped sub-tasks to (only 'dev' currently supports this, see
// PersonaInfo.supportsAgentLevel in settingsRegistry.ts). Deliberately a
// separate key rather than nesting under PLUGIN_ID_KEY so master and agent
// selections can be changed independently — see setSelectedAgentPluginId.
export const AGENT_PLUGIN_ID_KEY = '__agentPluginId'

// Prefix for agent-level field-override keys (e.g. "__agentField:model"),
// so the agent level's own personaOverridableFields can share the same
// flat map as the master level's unprefixed keys without colliding — both
// levels commonly use identical field keys like "model"/"thinking".
const AGENT_FIELD_PREFIX = '__agentField:'

export class PersonaSettingsStore {
  private readonly file: string

  constructor(settingsDir: string) {
    this.file = path.join(settingsDir, 'persona-settings.json')
  }

  private async readScoped(): Promise<ScopedPersonaSettingsData> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf-8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { admin: {}, user: {} }
      throw err
    }
    try {
      const parsed = JSON.parse(raw) as Partial<ScopedPersonaSettingsData>
      return { admin: parsed.admin ?? {}, user: parsed.user ?? {} }
    } catch {
      // Corrupted file (e.g. a torn/overlapping write) — treat like ENOENT
      // rather than 500ing every LLM-backed route until someone notices and
      // manually fixes the file on disk.
      return { admin: {}, user: {} }
    }
  }

  private async writeScoped(all: ScopedPersonaSettingsData): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true })
    await writeFile(this.file, JSON.stringify(all, null, 2), 'utf-8')
  }

  async readAll(scope: PersonaScope): Promise<PersonaSettingsData> {
    const all = await this.readScoped()
    return all[scope]
  }

  async getPersonaValues(scope: PersonaScope, personaId: string): Promise<Record<string, string>> {
    const all = await this.readAll(scope)
    return all[personaId] ?? {}
  }

  async setPersonaValues(
    scope: PersonaScope,
    personaId: string,
    values: Record<string, string>,
  ): Promise<void> {
    const all = await this.readScoped()
    all[scope][personaId] = { ...all[scope][personaId], ...values }
    await this.writeScoped(all)
  }

  // The chosen plugin for this persona in this scope, or undefined if
  // never overridden (caller falls back to the persona's built-in
  // defaultPluginId in that case).
  async getSelectedPluginId(scope: PersonaScope, personaId: string): Promise<string | undefined> {
    const values = await this.getPersonaValues(scope, personaId)
    return values[PLUGIN_ID_KEY] || undefined
  }

  // Replaces (not merges) the persona's stored values when switching
  // plugins, keeping only __pluginId. Field keys are unprefixed and
  // reused across plugins (every plugin's model field is just "model"),
  // so a plain merge would leave a prior plugin's override (e.g.
  // model: "sonnet" from Claude Code) sitting under the same key after
  // switching to GLM, which then gets sent verbatim as GLM's model
  // string and fails with an "unknown model" API error.
  async setSelectedPluginId(scope: PersonaScope, personaId: string, pluginId: string): Promise<void> {
    const all = await this.readScoped()
    all[scope][personaId] = { [PLUGIN_ID_KEY]: pluginId }
    await this.writeScoped(all)
  }

  // The chosen plugin for this persona's agent level in this scope, or
  // undefined if never set — there is no built-in default for the agent
  // level (it always starts unselected, unlike the master level's
  // defaultPluginId).
  async getSelectedAgentPluginId(scope: PersonaScope, personaId: string): Promise<string | undefined> {
    const values = await this.getPersonaValues(scope, personaId)
    return values[AGENT_PLUGIN_ID_KEY] || undefined
  }

  // Sets the agent-level plugin, clearing only the agent's own prior field
  // overrides (same "stale value under a reused key" concern
  // setSelectedPluginId guards against — switching agent plugin must not
  // leave e.g. a GLM model string sitting under "model" for a newly-picked
  // Claude Code agent). Unlike setSelectedPluginId this merges rather than
  // replacing the whole persona entry, since master and agent are
  // independent — switching the agent plugin must never touch the
  // master's own __pluginId or field overrides, and vice versa.
  async setSelectedAgentPluginId(scope: PersonaScope, personaId: string, pluginId: string): Promise<void> {
    const all = await this.readScoped()
    const existing = all[scope][personaId] ?? {}
    const withoutAgentFields: Record<string, string> = {}
    for (const [key, value] of Object.entries(existing)) {
      if (key === AGENT_PLUGIN_ID_KEY || key.startsWith(AGENT_FIELD_PREFIX)) continue
      withoutAgentFields[key] = value
    }
    all[scope][personaId] = { ...withoutAgentFields, [AGENT_PLUGIN_ID_KEY]: pluginId }
    await this.writeScoped(all)
  }

  // Clears the agent level entirely (back to "no agent selected"), leaving
  // the master level and its field overrides untouched.
  async clearSelectedAgentPluginId(scope: PersonaScope, personaId: string): Promise<void> {
    const all = await this.readScoped()
    const existing = all[scope][personaId] ?? {}
    const remaining: Record<string, string> = {}
    for (const [key, value] of Object.entries(existing)) {
      if (key === AGENT_PLUGIN_ID_KEY || key.startsWith(AGENT_FIELD_PREFIX)) continue
      remaining[key] = value
    }
    all[scope][personaId] = remaining
    await this.writeScoped(all)
  }

  // Merges agent-level field overrides (e.g. the agent plugin's own
  // "model"/"thinking" choices), stored under AGENT_FIELD_PREFIX-prefixed
  // keys so they can share the same flat per-persona map as the master
  // level's unprefixed field keys without colliding (both levels may use a
  // field key as plain as "model").
  async setAgentValues(
    scope: PersonaScope,
    personaId: string,
    values: Record<string, string>,
  ): Promise<void> {
    const all = await this.readScoped()
    const existing = all[scope][personaId] ?? {}
    const prefixed = Object.fromEntries(Object.entries(values).map(([k, v]) => [AGENT_FIELD_PREFIX + k, v]))
    all[scope][personaId] = { ...existing, ...prefixed }
    await this.writeScoped(all)
  }

  // Reads back agent-level field overrides, stripping AGENT_FIELD_PREFIX so
  // callers see the same plain field-key shape as getPersonaValues does for
  // the master level.
  async getAgentValues(scope: PersonaScope, personaId: string): Promise<Record<string, string>> {
    const values = await this.getPersonaValues(scope, personaId)
    const result: Record<string, string> = {}
    for (const [key, value] of Object.entries(values)) {
      if (key.startsWith(AGENT_FIELD_PREFIX)) result[key.slice(AGENT_FIELD_PREFIX.length)] = value
    }
    return result
  }
}
