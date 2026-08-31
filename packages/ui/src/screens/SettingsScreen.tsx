import { useEffect, useState } from 'react'
import type {
  OpenProjectResult,
  PersonaOverrideField,
  PersonaScope,
  PersonaSettings,
  PluginInstallStatus,
  PluginSettingField,
  PluginSettings,
  ProjectSettings,
  StorageInfo,
  VicCoreApi,
  VicUser,
} from '../api/types'
import './SettingsScreen.css'

interface SettingsScreenProps {
  api: VicCoreApi
  // Null when no project is open (landing screen) — the Gating section is
  // hidden in that case since it's a per-project setting with nothing to
  // apply it to yet.
  project: OpenProjectResult | null
  // Gates the Plugins/Personas tabs (LLM API keys + per-stage persona
  // assignment) to admins only — see VicUser.isAdmin. Everyone else still
  // gets full pipeline access, just not these config screens.
  currentUser: VicUser
  onProjectSettingsChange: (settings: ProjectSettings) => void
  onClose: () => void
}

function FieldInput({
  field,
  value,
  placeholder,
  onChange,
}: {
  field: Pick<PluginSettingField, 'type' | 'options'> & Partial<Pick<PluginSettingField, 'secret'>>
  value: string
  placeholder?: string
  onChange: (value: string) => void
}) {
  if (field.type === 'select') {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{placeholder ?? 'Use default'}</option>
        {field.options?.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    )
  }
  return (
    <input
      type={field.secret ? 'password' : 'text'}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

// Short "provider · model · effort" line shown on a collapsed persona card
// so the key facts stay visible without expanding. Pulls whichever fields
// look like model / effort by key, falling back to their raw label.
function personaSummary(
  persona: PersonaSettings,
  currentValue: (persona: PersonaSettings, field: PersonaOverrideField) => string,
): string {
  const bits: string[] = []
  bits.push(persona.pluginLabel ?? (persona.pluginId ? persona.pluginId : 'No provider'))
  for (const field of persona.fields) {
    const k = field.key.toLowerCase()
    if (k.includes('model') || k.includes('effort') || k.includes('reasoning') || k.includes('thinking')) {
      const v = currentValue(persona, field)
      if (v) bits.push(`${field.label}: ${v}`)
    }
  }
  return bits.join(' · ')
}

function PersonaCard({
  scope,
  persona,
  editable,
  collapsed,
  onToggleCollapsed,
  savedId,
  errorById,
  currentPersonaValue,
  currentAgentPersonaValue,
  onChangePlugin,
  onFieldChange,
  onSave,
  onChangeAgentPlugin,
  onAgentFieldChange,
  onSaveAgent,
}: {
  scope: PersonaScope
  persona: PersonaSettings
  collapsed: boolean
  onToggleCollapsed: () => void
  // Non-admins (and admins viewing the read-only branch) get a plain,
  // disabled rendering of whatever's currently saved — no drafts, no
  // dropdowns, no Save button. Matches "users can view the user persona
  // list but not edit it."
  editable: boolean
  savedId: string | null
  errorById: Record<string, string>
  currentPersonaValue: (scope: PersonaScope, persona: PersonaSettings, field: PersonaOverrideField) => string
  currentAgentPersonaValue: (
    scope: PersonaScope,
    persona: PersonaSettings,
    field: PersonaOverrideField,
  ) => string
  onChangePlugin: (scope: PersonaScope, personaId: string, pluginId: string) => void
  onFieldChange: (scope: PersonaScope, personaId: string, key: string, value: string) => void
  onSave: (scope: PersonaScope, personaId: string) => void
  onChangeAgentPlugin: (scope: PersonaScope, personaId: string, pluginId: string) => void
  onAgentFieldChange: (scope: PersonaScope, personaId: string, key: string, value: string) => void
  onSaveAgent: (scope: PersonaScope, personaId: string) => void
}) {
  const draftKey = `${scope}:${persona.id}`
  const summary = personaSummary(persona, (p, f) => currentPersonaValue(scope, p, f))

  const header = (
    <button type="button" className="settings-persona-card-header" onClick={onToggleCollapsed} aria-expanded={!collapsed}>
      <span className="settings-persona-card-toggle" aria-hidden="true">
        {collapsed ? '▸' : '▾'}
      </span>
      <span className="settings-persona-card-title">{persona.label}</span>
      <span className="settings-persona-card-summary">{summary}</span>
    </button>
  )

  if (!editable) {
    return (
      <div className="settings-plugin-card">
        {header}
        {!collapsed && (
          <>
            <p className="settings-field-description">
              {persona.pluginLabel ?? 'Not yet wired to an LLM provider — no stage uses this persona yet.'}
            </p>
            {persona.pluginId &&
              persona.fields
                .filter((field) => field.value)
                .map((field) => (
                  <p key={field.key} className="settings-field-description">
                    {field.label}: {field.value}
                  </p>
                ))}
            {persona.recommendation && persona.pluginId && (
              <p className="settings-persona-recommendation">
                <strong>Recommended:</strong>{' '}
                {Object.entries(persona.recommendation.values)
                  .map(([k, v]) => `${k} = ${v}`)
                  .join(', ')}{' '}
                — {persona.recommendation.why}
              </p>
            )}
          </>
        )}
      </div>
    )
  }

  if (collapsed) {
    return <div className="settings-plugin-card">{header}</div>
  }

  const recommendationHint =
    persona.recommendation && persona.pluginId ? (
      <p className="settings-persona-recommendation">
        <strong>Recommended:</strong>{' '}
        {Object.entries(persona.recommendation.values)
          .map(([k, v]) => `${k} = ${v}`)
          .join(', ')}{' '}
        — {persona.recommendation.why} Use “Auto-adopt recommended models” above to apply this to every persona.
      </p>
    ) : null

  return (
    <div className="settings-plugin-card">
      {header}
      {recommendationHint}
      <label className="settings-field">
        <div className="settings-field-label-row">
          <span>LLM provider</span>
        </div>
        <select
          value={persona.pluginId ?? ''}
          onChange={(e) => onChangePlugin(scope, persona.id, e.target.value)}
        >
          <option value="" disabled>
            Choose a provider
          </option>
          {persona.availablePlugins.map((plugin) => (
            <option key={plugin.id} value={plugin.id}>
              {plugin.label}
            </option>
          ))}
        </select>
      </label>
      {!persona.pluginId ? (
        <p className="settings-plugin-setup">
          Not yet wired to an LLM provider — no stage uses this persona yet.
        </p>
      ) : (
        <>
          {persona.fields.map((field) => (
            <label key={field.key} className="settings-field">
              <div className="settings-field-label-row">
                <span>{field.label}</span>
              </div>
              <FieldInput
                field={field}
                value={currentPersonaValue(scope, persona, field)}
                placeholder="Use default"
                onChange={(value) => onFieldChange(scope, persona.id, field.key, value)}
              />
              <p className="settings-field-description">{field.description}</p>
            </label>
          ))}
          <div className="settings-plugin-actions">
            <button type="button" onClick={() => onSave(scope, persona.id)}>
              Save
            </button>
            {savedId === draftKey && <span className="settings-saved">Saved</span>}
            {errorById[draftKey] && <span className="settings-error">{errorById[draftKey]}</span>}
          </div>
        </>
      )}
      {persona.supportsAgentLevel && (
        <>
          <h4 className="settings-agent-level-heading">Agent model</h4>
          <p className="settings-field-description">
            Optional second model this persona's master model can delegate scoped sub-tasks to.
          </p>
          <label className="settings-field">
            <div className="settings-field-label-row">
              <span>Agent LLM provider</span>
            </div>
            <select
              value={persona.agentPluginId ?? ''}
              onChange={(e) => onChangeAgentPlugin(scope, persona.id, e.target.value)}
            >
              <option value="">No agent model</option>
              {persona.availablePlugins.map((plugin) => (
                <option key={plugin.id} value={plugin.id}>
                  {plugin.label}
                </option>
              ))}
            </select>
          </label>
          {persona.agentPluginId && (
            <>
              {persona.agentFields.map((field) => (
                <label key={field.key} className="settings-field">
                  <div className="settings-field-label-row">
                    <span>{field.label}</span>
                  </div>
                  <FieldInput
                    field={field}
                    value={currentAgentPersonaValue(scope, persona, field)}
                    placeholder="Use default"
                    onChange={(value) => onAgentFieldChange(scope, persona.id, field.key, value)}
                  />
                  <p className="settings-field-description">{field.description}</p>
                </label>
              ))}
              <div className="settings-plugin-actions">
                <button type="button" onClick={() => onSaveAgent(scope, persona.id)}>
                  Save
                </button>
                {savedId === draftKey && <span className="settings-saved">Saved</span>}
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}

type SettingsTabId =
  | 'phase-navigation'
  | 'storage'
  | 'plugins'
  | 'personas-user'
  | 'personas-admin'

interface SettingsTab {
  id: SettingsTabId
  label: string
  // Phase navigation is per-project — hidden entirely (and so unreachable
  // as a tab) when no project is open, same as before tabs existed.
  projectOnly?: boolean
  // LLM API keys (Plugins) are admin-only (VicUser.isAdmin) — everyone else
  // keeps full pipeline access, just not this config screen. The user
  // persona list is NOT admin-only: everyone can view it, they just can't
  // edit it unless they're an admin. The admin persona list IS admin-only —
  // non-admins never see that sidebar entry at all.
  adminOnly?: boolean
}

const SETTINGS_TABS: SettingsTab[] = [
  { id: 'phase-navigation', label: 'Phase navigation', projectOnly: true },
  { id: 'storage', label: 'Storage' },
  { id: 'plugins', label: 'Plugins', adminOnly: true },
  { id: 'personas-user', label: 'Personas - User' },
  { id: 'personas-admin', label: 'Personas - Admin', adminOnly: true },
]

export function SettingsScreen({
  api,
  project,
  currentUser,
  onProjectSettingsChange,
  onClose,
}: SettingsScreenProps) {
  const [plugins, setPlugins] = useState<PluginSettings[]>([])
  // Two independent persona lists (see VicCoreApi.listPersonaSettings).
  // `admin` is only ever populated for an admin caller — the server omits
  // the key entirely for everyone else, which is what personaScopesToShow
  // below checks to decide whether an "admin personas" section renders at
  // all.
  const [personaLists, setPersonaLists] = useState<{ admin?: PersonaSettings[]; user: PersonaSettings[] }>({
    user: [],
  })
  const [pluginDrafts, setPluginDrafts] = useState<Record<string, Record<string, string>>>({})
  // Keyed by `${scope}:${personaId}` (not personaId alone) since an admin
  // can have an in-progress draft on the same persona id in both the
  // 'admin' and 'user' lists at once — a plain personaId key would let one
  // scope's edit clobber the other's.
  const [personaDrafts, setPersonaDrafts] = useState<Record<string, Record<string, string>>>({})
  // Separate draft map for agent-level field overrides — kept apart from
  // personaDrafts since both levels commonly reuse the same field keys
  // (e.g. "model"), which would otherwise collide in one shared draft.
  const [agentPersonaDrafts, setAgentPersonaDrafts] = useState<Record<string, Record<string, string>>>({})

  function personaDraftKey(scope: PersonaScope, personaId: string): string {
    return `${scope}:${personaId}`
  }
  const [savedId, setSavedId] = useState<string | null>(null)
  const [errorById, setErrorById] = useState<Record<string, string>>({})
  const [gatingSaving, setGatingSaving] = useState(false)
  const [statusById, setStatusById] = useState<Record<string, PluginInstallStatus>>({})
  const [statusCheckingId, setStatusCheckingId] = useState<string | null>(null)
  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null)
  const [projectsRootDraft, setProjectsRootDraft] = useState<string | null>(null)
  const [storageSaving, setStorageSaving] = useState(false)
  const [storageSaved, setStorageSaved] = useState(false)
  const [storageError, setStorageError] = useState('')
  const [activeTab, setActiveTab] = useState<SettingsTabId>(
    project ? 'phase-navigation' : 'storage',
  )
  const [savingAll, setSavingAll] = useState(false)
  const [saveAllError, setSaveAllError] = useState('')

  // Persona cards start collapsed (the list is long); a collapsed card still
  // shows its provider / model / effort summary. Keyed by `${scope}:${id}`.
  // `null` for a key that's never been toggled means "use the default"
  // (collapsed), so we don't need to pre-populate this once persona lists
  // load.
  const [expandedPersonas, setExpandedPersonas] = useState<Record<string, boolean>>({})
  function isPersonaExpanded(scope: PersonaScope, personaId: string): boolean {
    return expandedPersonas[personaDraftKey(scope, personaId)] ?? false
  }
  function togglePersonaExpanded(scope: PersonaScope, personaId: string) {
    const key = personaDraftKey(scope, personaId)
    setExpandedPersonas((prev) => ({ ...prev, [key]: !(prev[key] ?? false) }))
  }
  function collapseAllPersonas(scope: PersonaScope) {
    const list = scope === 'admin' ? personaLists.admin ?? [] : personaLists.user
    setExpandedPersonas((prev) => {
      const next = { ...prev }
      for (const p of list) next[personaDraftKey(scope, p.id)] = false
      return next
    })
  }
  function expandAllPersonas(scope: PersonaScope) {
    const list = scope === 'admin' ? personaLists.admin ?? [] : personaLists.user
    setExpandedPersonas((prev) => {
      const next = { ...prev }
      for (const p of list) next[personaDraftKey(scope, p.id)] = true
      return next
    })
  }

  const [autoAdoptBusy, setAutoAdoptBusy] = useState(false)
  const [autoAdoptResult, setAutoAdoptResult] = useState<string | null>(null)
  async function handleAutoAdopt(scope: PersonaScope) {
    if (autoAdoptBusy) return
    setAutoAdoptBusy(true)
    setAutoAdoptResult(null)
    try {
      const { applied } = await api.autoAdoptRecommendedModels(scope)
      // Re-fetch so the cards + summaries reflect the newly-written values,
      // and clear any stale drafts for the affected personas.
      const fresh = await api.listPersonaSettings()
      setPersonaLists(fresh)
      setPersonaDrafts((prev) => {
        const next = { ...prev }
        for (const a of applied) delete next[personaDraftKey(scope, a.personaId)]
        return next
      })
      setAutoAdoptResult(
        applied.length === 0
          ? 'No personas had a recommendation for their current provider — nothing changed.'
          : `Applied recommended models to ${applied.length} persona${applied.length === 1 ? '' : 's'}: ${applied
              .map((a) => a.personaId)
              .join(', ')}.`,
      )
    } catch (err) {
      setAutoAdoptResult(err instanceof Error ? err.message : 'Auto-adopt failed.')
    } finally {
      setAutoAdoptBusy(false)
    }
  }

  const visibleTabs = SETTINGS_TABS.filter(
    (tab) => (!tab.projectOnly || project) && (!tab.adminOnly || currentUser.isAdmin),
  )

  useEffect(() => {
    api.listPluginSettings().then(setPlugins)
    api.listPersonaSettings().then(setPersonaLists)
    api.getStorageInfo().then(setStorageInfo)
  }, [api])

  async function handleGatingChange(gated: boolean) {
    if (!project || gatingSaving) return
    setGatingSaving(true)
    try {
      const updated = await api.updateProjectSettings(project.projectId, {
        phaseTabGating: gated ? 'gated' : 'always-accessible',
      })
      onProjectSettingsChange(updated)
    } finally {
      setGatingSaving(false)
    }
  }


  function setPluginDraftValue(pluginId: string, key: string, value: string) {
    setPluginDrafts((prev) => ({ ...prev, [pluginId]: { ...prev[pluginId], [key]: value } }))
  }

  function setPersonaDraftValue(scope: PersonaScope, personaId: string, key: string, value: string) {
    const draftKey = personaDraftKey(scope, personaId)
    setPersonaDrafts((prev) => ({ ...prev, [draftKey]: { ...prev[draftKey], [key]: value } }))
  }

  function setAgentPersonaDraftValue(scope: PersonaScope, personaId: string, key: string, value: string) {
    const draftKey = personaDraftKey(scope, personaId)
    setAgentPersonaDrafts((prev) => ({ ...prev, [draftKey]: { ...prev[draftKey], [key]: value } }))
  }

  function flashSaved(id: string) {
    setSavedId(id)
    setTimeout(() => setSavedId((current) => (current === id ? null : current)), 2000)
  }

  async function handleCheckPluginStatus(pluginId: string) {
    setStatusCheckingId(pluginId)
    try {
      const status = await api.checkPluginStatus(pluginId)
      setStatusById((prev) => ({ ...prev, [pluginId]: status }))
    } catch (err) {
      setStatusById((prev) => ({
        ...prev,
        [pluginId]: { installed: false, error: (err as Error).message },
      }))
    } finally {
      setStatusCheckingId(null)
    }
  }

  async function handleSaveProjectsRootOverride() {
    if (projectsRootDraft === null || storageSaving) return
    setStorageSaving(true)
    setStorageError('')
    try {
      await api.setProjectsRootOverride(projectsRootDraft.trim() || null)
      setStorageInfo(await api.getStorageInfo())
      setProjectsRootDraft(null)
      setStorageSaved(true)
      setTimeout(() => setStorageSaved(false), 2000)
    } catch (err) {
      setStorageError((err as Error).message)
    } finally {
      setStorageSaving(false)
    }
  }

  async function handleSavePlugin(pluginId: string) {
    const values = pluginDrafts[pluginId] ?? {}
    setErrorById((prev) => ({ ...prev, [pluginId]: '' }))
    try {
      // Snapshot before this save completes — used below to detect "this was
      // the very first plugin ever configured," since after the save every
      // plugin (including this one) will look configured. A plugin counts as
      // configured once any of its fields has a stored value (e.g. an API key).
      const noPluginConfiguredYet = plugins.every((p) => !p.fields.some((f) => f.hasValue))
      const noPersonaAssignedYet = [...(personaLists.admin ?? []), ...personaLists.user].every(
        (p) => !p.pluginId,
      )

      await api.savePluginSettings(pluginId, values)
      setPlugins(await api.listPluginSettings())
      setPluginDrafts((prev) => ({ ...prev, [pluginId]: {} }))
      flashSaved(pluginId)

      // First LLM plugin ever set up (Settings > Plugins): wire it to every
      // persona automatically so the app is usable end-to-end without a
      // separate trip to Settings > Personas. Only fires once — once any
      // persona has a plugin assigned, later plugin saves (a second
      // provider, a key rotation) don't touch persona assignments.
      if (noPluginConfiguredYet && noPersonaAssignedYet) {
        await handleApplyPluginToAllPersonas(pluginId)
      }
    } catch (err) {
      setErrorById((prev) => ({ ...prev, [pluginId]: (err as Error).message }))
    }
  }

  // "Apply to all Personas" (Plugins tab, per plugin card) — assigns this
  // plugin as every persona's provider, in both lists, in one action, same
  // underlying call handleChangePersonaPlugin makes for a single persona
  // (empty field overrides, so each persona falls back to the plugin's own
  // defaults). Only reachable by an admin (Plugins tab is adminOnly), so
  // both personaLists.admin and .user are populated at this point.
  async function handleApplyPluginToAllPersonas(pluginId: string) {
    setErrorById((prev) => ({ ...prev, [pluginId]: '' }))
    try {
      const allScoped: Array<{ scope: PersonaScope; persona: PersonaSettings }> = [
        ...(personaLists.admin ?? []).map((persona) => ({ scope: 'admin' as const, persona })),
        ...personaLists.user.map((persona) => ({ scope: 'user' as const, persona })),
      ]
      await Promise.all(
        allScoped.map(({ scope, persona }) => api.savePersonaSettings(scope, persona.id, {}, pluginId)),
      )
      setPersonaLists(await api.listPersonaSettings())
      setPersonaDrafts({})
      flashSaved(pluginId)
    } catch (err) {
      setErrorById((prev) => ({ ...prev, [pluginId]: (err as Error).message }))
    }
  }

  async function handleSavePersona(scope: PersonaScope, personaId: string) {
    const key = personaDraftKey(scope, personaId)
    const values = personaDrafts[key] ?? {}
    setErrorById((prev) => ({ ...prev, [key]: '' }))
    try {
      await api.savePersonaSettings(scope, personaId, values)
      setPersonaLists(await api.listPersonaSettings())
      setPersonaDrafts((prev) => ({ ...prev, [key]: {} }))
      flashSaved(key)
    } catch (err) {
      setErrorById((prev) => ({ ...prev, [key]: (err as Error).message }))
    }
  }

  async function handleChangePersonaPlugin(scope: PersonaScope, personaId: string, pluginId: string) {
    const key = personaDraftKey(scope, personaId)
    setErrorById((prev) => ({ ...prev, [key]: '' }))
    try {
      // Switching plugins drops any in-progress field-override draft — the
      // new plugin's fields (and defaults) are unrelated to the old one's.
      await api.savePersonaSettings(scope, personaId, {}, pluginId)
      setPersonaLists(await api.listPersonaSettings())
      setPersonaDrafts((prev) => ({ ...prev, [key]: {} }))
      flashSaved(key)
    } catch (err) {
      setErrorById((prev) => ({ ...prev, [key]: (err as Error).message }))
    }
  }

  function currentPersonaValue(scope: PersonaScope, persona: PersonaSettings, field: PersonaOverrideField): string {
    return personaDrafts[personaDraftKey(scope, persona.id)]?.[field.key] ?? field.value
  }

  function currentAgentPersonaValue(
    scope: PersonaScope,
    persona: PersonaSettings,
    field: PersonaOverrideField,
  ): string {
    return agentPersonaDrafts[personaDraftKey(scope, persona.id)]?.[field.key] ?? field.value
  }

  async function handleSaveAgentPersona(scope: PersonaScope, personaId: string) {
    const key = personaDraftKey(scope, personaId)
    const agentValues = agentPersonaDrafts[key] ?? {}
    setErrorById((prev) => ({ ...prev, [key]: '' }))
    try {
      await api.savePersonaSettings(scope, personaId, {}, undefined, agentValues)
      setPersonaLists(await api.listPersonaSettings())
      setAgentPersonaDrafts((prev) => ({ ...prev, [key]: {} }))
      flashSaved(key)
    } catch (err) {
      setErrorById((prev) => ({ ...prev, [key]: (err as Error).message }))
    }
  }

  // pluginId '' means "clear the agent-level selection" (the "Use default"
  // / unset option in the dropdown) — mirrored server-side by
  // clearSelectedAgentPluginId.
  async function handleChangeAgentPersonaPlugin(scope: PersonaScope, personaId: string, pluginId: string) {
    const key = personaDraftKey(scope, personaId)
    setErrorById((prev) => ({ ...prev, [key]: '' }))
    try {
      await api.savePersonaSettings(scope, personaId, {}, undefined, {}, pluginId)
      setPersonaLists(await api.listPersonaSettings())
      setAgentPersonaDrafts((prev) => ({ ...prev, [key]: {} }))
      flashSaved(key)
    } catch (err) {
      setErrorById((prev) => ({ ...prev, [key]: (err as Error).message }))
    }
  }

  // Global "Save" in the footer — saves every plugin/persona card with a
  // pending (non-empty) draft in one click, on top of each card's own
  // individual Save button, then closes the dialog (same as clicking the ×,
  // just after committing whatever was pending). Persona cards with no
  // plugin chosen yet have nothing meaningful to save, so they're skipped
  // rather than erroring. On failure the dialog stays open so the user can
  // see and fix the error.
  async function handleSaveAll() {
    setSavingAll(true)
    setSaveAllError('')
    try {
      const pluginIds = Object.keys(pluginDrafts).filter(
        (id) => Object.keys(pluginDrafts[id] ?? {}).length > 0,
      )
      const allPersonas: Array<{ scope: PersonaScope; persona: PersonaSettings }> = [
        ...(personaLists.admin ?? []).map((persona) => ({ scope: 'admin' as const, persona })),
        ...personaLists.user.map((persona) => ({ scope: 'user' as const, persona })),
      ]
      const personaKeys = Object.keys(personaDrafts).filter((key) => {
        if (Object.keys(personaDrafts[key] ?? {}).length === 0) return false
        const found = allPersonas.find(({ scope, persona }) => personaDraftKey(scope, persona.id) === key)
        return found?.persona.pluginId
      })
      await Promise.all([
        ...pluginIds.map((id) => handleSavePlugin(id)),
        ...personaKeys.map((key) => {
          const [scope, personaId] = key.split(':') as [PersonaScope, string]
          return handleSavePersona(scope, personaId)
        }),
      ])
      onClose()
    } catch (err) {
      setSaveAllError((err as Error).message)
      setSavingAll(false)
    }
  }

  return (
    <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="Settings">
      <div className="settings-panel">
        <div className="settings-header">
          <h1>Settings</h1>
          <button type="button" className="settings-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="settings-body">
          <nav className="settings-tabs" aria-label="Settings sections">
            {visibleTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`settings-tab ${activeTab === tab.id ? 'active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
                aria-current={activeTab === tab.id}
              >
                {tab.label}
              </button>
            ))}
          </nav>

          <div className="settings-tab-content">
            {activeTab === 'phase-navigation' && project && (
              <section className="settings-section">
                <h2>Phase navigation</h2>
                <label className="settings-field settings-field-checkbox">
                  <span className="settings-field-label-row">
                    <input
                      type="checkbox"
                      checked={project.settings.phaseTabGating === 'gated'}
                      disabled={gatingSaving}
                      onChange={(e) => handleGatingChange(e.target.checked)}
                    />
                    <span>Require sign-off before unlocking later phase tabs</span>
                  </span>
                  <p className="settings-field-description">
                    When on, a phase tab (Architecture, Coding, ...) stays disabled until the
                    preceding phase is signed off. Off by default — sign-off isn't built yet and
                    this tool is single-user, so every phase tab is clickable at any time. Turn
                    this on later once phase sign-off exists, if you want to enforce working in
                    order.
                  </p>
                </label>
              </section>
            )}

            {activeTab === 'storage' && (
              <section className="settings-section">
                <h2>Storage</h2>
                {storageInfo ? (
                  <>
                    <p className="settings-field settings-storage-row">
                      <span className="settings-field-label-row">
                        <span>Projects — currently active</span>
                        {storageInfo.projectsRootIsDefault && (
                          <span className="settings-field-set-badge">Default</span>
                        )}
                      </span>
                      <code className="settings-storage-path">{storageInfo.projectsRoot}</code>
                    </p>
                    {storageInfo.projectsRootSource === 'env' && (
                      <p className="settings-section-note">
                        Set by the <code>VIC_PROJECTS_ROOT</code> environment variable, which
                        takes priority over the folder setting below. To use the setting below
                        instead, remove that environment variable and restart the server.
                      </p>
                    )}

                    <label className="settings-field">
                      <span className="settings-field-label-row">
                        <span>Storage folder</span>
                      </span>
                      <input
                        type="text"
                        placeholder={storageInfo.projectsRootOverride ?? 'e.g. Z:\\VIC-Shared or \\\\server\\share\\VIC-Shared'}
                        value={projectsRootDraft ?? ''}
                        onChange={(e) => setProjectsRootDraft(e.target.value)}
                      />
                      <p className="settings-field-description">
                        All project storage (project files and the generated/imported source
                        tree) will be read from and written to this folder — any local path or
                        mapped network drive. Takes effect the next time the server is
                        restarted, and does not move any existing project data already stored
                        at the current location — copy it there yourself first if you want it
                        to carry over.
                      </p>
                    </label>
                    <div className="settings-plugin-actions">
                      <button
                        type="button"
                        onClick={handleSaveProjectsRootOverride}
                        disabled={projectsRootDraft === null || storageSaving}
                      >
                        {storageSaving ? 'Saving…' : 'Save'}
                      </button>
                      {storageInfo.projectsRootOverride && (
                        <button
                          type="button"
                          className="settings-plugin-actions-secondary"
                          onClick={() => setProjectsRootDraft('')}
                          disabled={storageSaving}
                        >
                          Clear override
                        </button>
                      )}
                      {storageSaved && <span className="settings-saved">Saved — restart the server to apply</span>}
                      {storageError && <span className="settings-error">{storageError}</span>}
                    </div>

                    <p className="settings-field settings-storage-row">
                      <span className="settings-field-label-row">
                        <span>Plugin settings / secrets</span>
                        {storageInfo.secretsDirIsDefault && (
                          <span className="settings-field-set-badge">Default</span>
                        )}
                      </span>
                      <code className="settings-storage-path">{storageInfo.secretsDir}</code>
                    </p>
                    <p className="settings-section-note">
                      To store these somewhere else, set the <code>VIC_SECRETS_DIR</code>{' '}
                      environment variable before starting the server, then restart it — this
                      one is read-only here, not an editable field.
                    </p>
                  </>
                ) : (
                  <p className="settings-section-note">Loading…</p>
                )}
              </section>
            )}

            {activeTab === 'plugins' && currentUser.isAdmin && (
              <section className="settings-section">
                <h2>Plugins</h2>
                <p className="settings-section-note">
                  Configuration for installed plugin modules (LLM providers, and future plugin
                  types). Values are stored locally and never included in project exports.
                </p>

                {plugins.length === 0 && <p className="settings-empty">No plugins installed.</p>}

                {plugins.map((plugin) => (
                  <div key={plugin.id} className="settings-plugin-card">
                    <h3>{plugin.label}</h3>
                    <p className="settings-plugin-setup">
                      {plugin.setupSummary}
                      {plugin.setupUrl && (
                        <>
                          {' '}
                          <a href={plugin.setupUrl} target="_blank" rel="noreferrer">
                            Get an API key ↗
                          </a>
                        </>
                      )}
                    </p>
                    {plugin.cliCheckable && (
                      <div className="settings-plugin-status">
                        <button
                          type="button"
                          onClick={() => handleCheckPluginStatus(plugin.id)}
                          disabled={statusCheckingId === plugin.id}
                        >
                          {statusCheckingId === plugin.id ? 'Checking…' : 'Check installation'}
                        </button>
                        {statusById[plugin.id] &&
                          (statusById[plugin.id].installed ? (
                            <span className="settings-saved">
                              Installed
                              {statusById[plugin.id].version ? ` — ${statusById[plugin.id].version}` : ''}
                            </span>
                          ) : (
                            <span className="settings-error">
                              Not available
                              {statusById[plugin.id].error ? ` — ${statusById[plugin.id].error}` : ''}
                            </span>
                          ))}
                      </div>
                    )}
                    {plugin.fields.map((field) => (
                      <label key={field.key} className="settings-field">
                        <div className="settings-field-label-row">
                          <span>{field.label}</span>
                          {field.secret && field.hasValue && (
                            <span className="settings-field-set-badge">Set</span>
                          )}
                        </div>
                        <FieldInput
                          field={field}
                          value={pluginDrafts[plugin.id]?.[field.key] ?? ''}
                          placeholder={
                            field.type === 'select'
                              ? (field.options?.find((o) => o.value === field.value)?.label ??
                                'Use default')
                              : field.secret && field.hasValue
                                ? 'Leave blank to keep the current value'
                                : field.value || ''
                          }
                          onChange={(value) => setPluginDraftValue(plugin.id, field.key, value)}
                        />
                        <p className="settings-field-description">{field.description}</p>
                      </label>
                    ))}
                    <div className="settings-plugin-actions">
                      <button type="button" onClick={() => handleSavePlugin(plugin.id)}>
                        Save
                      </button>
                      <button
                        type="button"
                        className="settings-plugin-actions-secondary"
                        onClick={() => handleApplyPluginToAllPersonas(plugin.id)}
                        disabled={personaLists.user.length === 0}
                        title="Assign this LLM provider to every persona (Analyst, Architect, ...) in one step."
                      >
                        Apply to all Personas
                      </button>
                      {savedId === plugin.id && <span className="settings-saved">Saved</span>}
                      {errorById[plugin.id] && (
                        <span className="settings-error">{errorById[plugin.id]}</span>
                      )}
                    </div>
                  </div>
                ))}
              </section>
            )}

            {activeTab === 'personas-user' && (
              <section className="settings-section">
                <h2>Personas - User</h2>
                <p className="settings-section-note">
                  Per-stage persona overrides (e.g. a cheaper/faster model just for the Analyst).
                  Leave a field on "Use default" to fall back to the backing plugin's own setting
                  above. Backs the pipeline for everyone else. Visible to all users; only admins
                  can edit it.
                </p>

                {personaLists.user.length > 0 && (
                  <>
                    <div className="settings-persona-list-actions">
                      <button type="button" onClick={() => collapseAllPersonas('user')}>
                        Collapse all
                      </button>
                      <button type="button" onClick={() => expandAllPersonas('user')}>
                        Expand all
                      </button>
                      {currentUser.isAdmin && (
                        <button
                          type="button"
                          className="settings-persona-auto-adopt"
                          onClick={() => handleAutoAdopt('user')}
                          disabled={autoAdoptBusy}
                          title="Set every persona's model / effort to VIC's recommendation for its current provider (e.g. a fast model for QA test-file writing, a strong one for the Analyst). Doesn't change which provider a persona uses."
                        >
                          {autoAdoptBusy ? 'Applying…' : 'Auto-adopt recommended models'}
                        </button>
                      )}
                    </div>
                    {autoAdoptResult && <p className="settings-section-note">{autoAdoptResult}</p>}
                  </>
                )}

                {personaLists.user.map((persona) => (
                  <PersonaCard
                    key={persona.id}
                    scope="user"
                    persona={persona}
                    editable={currentUser.isAdmin}
                    collapsed={!isPersonaExpanded('user', persona.id)}
                    onToggleCollapsed={() => togglePersonaExpanded('user', persona.id)}
                    savedId={savedId}
                    errorById={errorById}
                    currentPersonaValue={currentPersonaValue}
                    currentAgentPersonaValue={currentAgentPersonaValue}
                    onChangePlugin={handleChangePersonaPlugin}
                    onFieldChange={setPersonaDraftValue}
                    onSave={handleSavePersona}
                    onChangeAgentPlugin={handleChangeAgentPersonaPlugin}
                    onAgentFieldChange={setAgentPersonaDraftValue}
                    onSaveAgent={handleSaveAgentPersona}
                  />
                ))}
              </section>
            )}

            {activeTab === 'personas-admin' && currentUser.isAdmin && personaLists.admin && (
              <section className="settings-section">
                <h2>Personas - Admin</h2>
                <p className="settings-section-note">
                  Per-stage persona overrides (e.g. a cheaper/faster model just for the Analyst).
                  Leave a field on "Use default" to fall back to the backing plugin's own setting
                  above. Backs the pipeline when you run it.
                </p>

                {personaLists.admin.length > 0 && (
                  <>
                    <div className="settings-persona-list-actions">
                      <button type="button" onClick={() => collapseAllPersonas('admin')}>
                        Collapse all
                      </button>
                      <button type="button" onClick={() => expandAllPersonas('admin')}>
                        Expand all
                      </button>
                      <button
                        type="button"
                        className="settings-persona-auto-adopt"
                        onClick={() => handleAutoAdopt('admin')}
                        disabled={autoAdoptBusy}
                        title="Set every persona's model / effort to VIC's recommendation for its current provider. Doesn't change which provider a persona uses."
                      >
                        {autoAdoptBusy ? 'Applying…' : 'Auto-adopt recommended models'}
                      </button>
                    </div>
                    {autoAdoptResult && <p className="settings-section-note">{autoAdoptResult}</p>}
                  </>
                )}

                {personaLists.admin.map((persona) => (
                  <PersonaCard
                    key={persona.id}
                    scope="admin"
                    persona={persona}
                    editable
                    collapsed={!isPersonaExpanded('admin', persona.id)}
                    onToggleCollapsed={() => togglePersonaExpanded('admin', persona.id)}
                    savedId={savedId}
                    errorById={errorById}
                    currentPersonaValue={currentPersonaValue}
                    currentAgentPersonaValue={currentAgentPersonaValue}
                    onChangePlugin={handleChangePersonaPlugin}
                    onFieldChange={setPersonaDraftValue}
                    onSave={handleSavePersona}
                    onChangeAgentPlugin={handleChangeAgentPersonaPlugin}
                    onAgentFieldChange={setAgentPersonaDraftValue}
                    onSaveAgent={handleSaveAgentPersona}
                  />
                ))}
              </section>
            )}
          </div>
        </div>

        <div className="settings-footer">
          <div className="settings-footer-status">
            {saveAllError && <span className="settings-error">{saveAllError}</span>}
          </div>
          <button
            type="button"
            className="settings-save-all"
            onClick={handleSaveAll}
            disabled={savingAll}
          >
            {savingAll ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
