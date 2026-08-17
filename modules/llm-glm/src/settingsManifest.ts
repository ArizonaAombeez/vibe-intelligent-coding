// Generic descriptor so a settings UI can render fields for this plugin
// without hardcoding "GLM" by name anywhere outside this module. Any future
// LLM provider module exports the same shape; the application layer (the
// server) just collects these from every installed plugin and serves them
// generically — adding a new provider needs zero server/UI changes.

export interface PluginSettingOption {
  value: string
  label: string
}

export interface PluginSettingField {
  key: string
  label: string
  description: string
  secret: boolean
  // 'text' (free input), 'select' (fixed choice from `options`). z.ai has
  // no API endpoint to list available models or thinking modes at
  // request time — these are curated lists shipped by the plugin, not
  // fetched live. Updating them when z.ai ships a new model is a one-line
  // change here, not a UI change.
  type: 'text' | 'select'
  options?: PluginSettingOption[]
}

export interface PluginSettingsManifest {
  id: string
  label: string
  // Short human-readable statement of what this plugin needs to work —
  // e.g. "Cloud API only — nothing to install locally" vs. "Requires the
  // Foo CLI installed and on PATH". Every plugin in the library fills this
  // in so the Settings screen can render setup expectations generically,
  // without the UI needing to know plugin-specific installation details.
  setupSummary: string
  // Where to go to obtain credentials (e.g. an API key signup page).
  // Optional — a plugin with no external account requirement omits it.
  setupUrl?: string
  fields: PluginSettingField[]
  // Fields any persona-level override may also offer (a subset of the
  // above, non-secret only — a persona override never carries credentials,
  // only per-call knobs like model/thinking). Declared separately from
  // `fields` so the application layer knows which keys are safe to expose
  // per-persona vs. plugin-global-only (e.g. apiKey never appears here).
  personaOverridableFields: PluginSettingField[]
}

export const KNOWN_GLM_MODELS: PluginSettingOption[] = [
  { value: 'glm-5.2', label: 'GLM-5.2 (1M context, strongest reasoning/coding)' },
  { value: 'glm-4.7', label: 'GLM-4.7' },
  { value: 'glm-4.7-flash', label: 'GLM-4.7-Flash (free)' },
  { value: 'glm-4.5', label: 'GLM-4.5' },
  { value: 'glm-4.5-air', label: 'GLM-4.5-Air (cheaper, smaller)' },
  { value: 'glm-4.5-x', label: 'GLM-4.5-X (premium)' },
]

// z.ai's "thinking" parameter is a simple on/off switch (no graduated
// effort levels like some other providers) — { type: 'enabled' | 'disabled' }.
export const THINKING_OPTIONS: PluginSettingOption[] = [
  { value: 'enabled', label: 'Enabled (default — dynamic extended reasoning)' },
  { value: 'disabled', label: 'Disabled (faster, no reasoning trace)' },
]

// z.ai splits billing across two separate products behind two separate
// base URLs, using the exact same OpenAI-compatible request/response shape:
// - Pay-as-you-go API: metered per-token credit balance, api/paas/v4.
// - Coding Plan: flat-rate subscription (Lite/Pro/Max) with a separate
//   included usage allowance, api/coding/paas/v4. A Coding Plan API key
//   gets a 429 "insufficient balance" on the PAYG endpoint since it has
//   no metered credit balance — it must be called via the Coding Plan
//   endpoint instead to draw from the subscription's included usage.
export const ACCESS_METHOD_OPTIONS: PluginSettingOption[] = [
  { value: 'coding-plan', label: 'Coding Plan (GLM Lite/Pro/Max subscription — included usage)' },
  { value: 'payg', label: 'Pay-as-you-go API (metered credit balance)' },
]

const accessMethodField: PluginSettingField = {
  key: 'accessMethod',
  label: 'Access method',
  description:
    'z.ai bills the Coding Plan subscription and the pay-as-you-go API separately, via different endpoints, even though a Coding Plan key looks like a normal API key. Pick Coding Plan if you have a GLM Lite/Pro/Max subscription — using the wrong one causes a 401/429 even with a valid, funded account.',
  secret: false,
  type: 'select',
  options: ACCESS_METHOD_OPTIONS,
}

const modelField: PluginSettingField = {
  key: 'model',
  label: 'Model',
  description:
    'The z.ai GLM model to use. This list is curated by the plugin — z.ai has no API to fetch it live — and is updated here when new models ship.',
  secret: false,
  type: 'select',
  options: KNOWN_GLM_MODELS,
}

const thinkingField: PluginSettingField = {
  key: 'thinking',
  label: 'Thinking',
  description:
    'Whether GLM uses extended reasoning ("thinking") before responding. z.ai only supports on/off, not graduated effort levels.',
  secret: false,
  type: 'select',
  options: THINKING_OPTIONS,
}

export const settingsManifest: PluginSettingsManifest = {
  id: 'vic-llm-glm',
  label: 'GLM (z.ai)',
  setupSummary:
    'Cloud API only — nothing to install locally for chat-based stages (Analyst, Architect, PM, QA, Code Gap Scan). VIC calls the z.ai GLM API directly over HTTPS using your API key. If you also select GLM for the Dev persona, the Coding stage additionally requires the open-source OpenCode CLI installed and on PATH (npm install -g opencode-ai) — GLM has no filesystem/tool-use capability of its own, so Coding drives OpenCode (pointed at this same API key/model) rather than calling the chat API directly.',
  setupUrl: 'https://z.ai/manage-apikey/apikey-list',
  fields: [
    {
      key: 'apiKey',
      label: 'API Key',
      description:
        'Your z.ai API key, used by the Analyst persona (and other stages later) to call the GLM chat/completions API. Stored locally, never included in project exports.',
      secret: true,
      type: 'text',
    },
    accessMethodField,
    modelField,
    thinkingField,
  ],
  personaOverridableFields: [modelField, thinkingField],
}
