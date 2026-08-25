// Mirrors vic-llm-glm's settingsManifest shape (see that module for the
// full field-by-field rationale) so the server can collect this plugin's
// manifest the exact same generic way. The one structural difference: this
// plugin has no secret field. Auth is the `claude` CLI's own OAuth login
// (whatever `claude /login` already set up on this machine) — VIC never
// stores or sees a credential for it, unlike an API-key-backed provider.

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

// Claude Code has no API to list installed/available models, so this is a
// curated list like vic-llm-glm's KNOWN_GLM_MODELS — updated here when a
// new model ships. Empty value means "let the CLI use its own default".
export const KNOWN_CLAUDE_CODE_MODELS: PluginSettingOption[] = [
  { value: '', label: "CLI default (whatever `claude` is configured to use)" },
  { value: 'opus', label: 'Opus 5' },
  { value: 'sonnet', label: 'Sonnet 5' },
  { value: 'haiku', label: 'Haiku 4.5' },
]

const modelField: PluginSettingField = {
  key: 'model',
  label: 'Model',
  description:
    'Passed to the CLI as --model. Leave on "CLI default" to use whatever claude is already configured to use.',
  secret: false,
  type: 'select',
  options: KNOWN_CLAUDE_CODE_MODELS,
}

// The CLI's --effort flag (low, medium, high, xhigh, max) sets reasoning
// effort for the session. Empty value means "let the CLI use its own
// default" — same convention as the model field's blank option.
export const EFFORT_OPTIONS: PluginSettingOption[] = [
  { value: '', label: 'CLI default' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'X-High' },
  { value: 'max', label: 'Max' },
]

const effortField: PluginSettingField = {
  key: 'effort',
  label: 'Effort',
  description:
    'Passed to the CLI as --effort. Higher effort spends more reasoning before responding, at the cost of speed. Leave on "CLI default" to use whatever claude is already configured to use.',
  secret: false,
  type: 'select',
  options: EFFORT_OPTIONS,
}

export const settingsManifest: PluginSettingsManifest = {
  id: 'vic-llm-claude-code',
  label: 'Claude Code (Pro/Max plan)',
  setupSummary:
    'Requires the Claude Code CLI installed and on PATH, logged in with a Claude Pro or Max subscription (run `claude` once and complete /login). VIC drives it as a local subprocess (claude --print) rather than calling an API — usage is billed against your Pro/Max plan\'s included usage, not a metered API key, and there is no API key to enter here.',
  setupUrl: 'https://docs.claude.com/en/docs/claude-code/setup',
  fields: [modelField, effortField],
  personaOverridableFields: [modelField, effortField],
}
