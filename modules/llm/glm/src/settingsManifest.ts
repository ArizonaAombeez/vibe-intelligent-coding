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

// Relative Coding-run speed notes below come from one real, timed,
// button-press-to-idle comparison on a single element (ARCH-001, Worm Game
// project, 2026-08-23) — glm-4.7 was the fastest/only-reliable model
// observed and is used as the 100% baseline; the others are expressed
// relative to it. This is n=1 per model, not a statistically robust
// benchmark — GLM's own run-to-run variance was substantial in the same
// session (an earlier glm-5.2 run succeeded in ~400s, a later one failed
// outright in ~205s) — so treat these as a directional signal to revisit
// periodically, not a permanent ranking. Update this comment (and the
// labels below) if a more thorough comparison changes the picture.
export const KNOWN_GLM_MODELS: PluginSettingOption[] = [
  { value: 'glm-5.3', label: 'GLM-5.3 (~2.3x slower than GLM-4.7, thinking always on — see reasoning effort)' },
  { value: 'glm-5.2', label: 'GLM-5.2 (~2.6x slower than GLM-4.7; also failed with empty output in the same test)' },
  { value: 'glm-4.7', label: 'GLM-4.7 (fastest/most reliable observed for Coding runs — recommended default)' },
  { value: 'glm-4.7-flash', label: 'GLM-4.7-Flash (free, not yet timed against the others)' },
  { value: 'glm-4.5', label: 'GLM-4.5 (not yet timed against the others)' },
  { value: 'glm-4.5-air', label: 'GLM-4.5-Air (cheaper, smaller, not yet timed against the others)' },
  { value: 'glm-4.5-x', label: 'GLM-4.5-X (premium, not yet timed against the others)' },
]

// z.ai's "thinking" parameter is a simple on/off switch (no graduated
// effort levels like some other providers) — { type: 'enabled' | 'disabled' }.
// Only meaningful for models where GLM_MODEL_CAPABILITIES below reports
// canDisableThinking:true — GLM-5.3 cannot disable thinking at all (see that
// table), so this field is hidden/ignored for it rather than sent and
// silently rejected.
export const THINKING_OPTIONS: PluginSettingOption[] = [
  { value: 'enabled', label: 'Enabled (default — dynamic extended reasoning)' },
  { value: 'disabled', label: 'Disabled (faster, no reasoning trace)' },
]

// z.ai's reasoning_effort, sent via extra_body (not part of the standard
// OpenAI-compatible request shape) — a SEPARATE, more granular knob from
// `thinking` above, only meaningful when thinking is (or must be) on. Only
// documented for the GLM-5.x line; see GLM_MODEL_CAPABILITIES for which
// values each specific model actually accepts (5.2: high/max only; 5.3:
// low/high/max, defaulting to max). Not documented for GLM-4.7 or older —
// deliberately not offered for those models rather than guessed at.
export const REASONING_EFFORT_OPTIONS: PluginSettingOption[] = [
  { value: 'low', label: 'Low (fastest, lightest reasoning — GLM-5.3 only)' },
  { value: 'high', label: 'High (enhanced reasoning)' },
  { value: 'max', label: 'Max (deepest reasoning, default — z.ai recommends this for coding)' },
]

export interface GlmModelCapabilities {
  // false only for GLM-5.3, where reasoning is mandatory — thinking:disabled
  // has no effect and should not be sent. True for every other known model
  // (5.2, 4.7, 4.7-flash, 4.5 family), all of which support the plain on/off
  // switch.
  canDisableThinking: boolean
  // Which reasoning_effort values this specific model actually accepts, or
  // undefined if the model doesn't document support for the parameter at
  // all (GLM-4.7 and older) — in that case the field is omitted from the
  // request entirely rather than sent and possibly rejected/ignored.
  reasoningEffortValues?: string[]
}

// Per-model lookup so callers (ZaiGlmClient, OpenCodeAgentClient) only ever
// send a thinking/reasoning_effort combination the selected model actually
// documents support for, rather than applying one flat set of options to
// every model in KNOWN_GLM_MODELS regardless of whether it's meaningful.
// Falls back to the safe default (canDisableThinking:true, no
// reasoningEffortValues) for any model not explicitly listed here — a
// future/unlisted model is assumed to behave like the common case (a plain
// on/off thinking switch, no special effort levels) rather than the GLM-5.3
// special case.
export const GLM_MODEL_CAPABILITIES: Record<string, GlmModelCapabilities> = {
  'glm-5.3': { canDisableThinking: false, reasoningEffortValues: ['low', 'high', 'max'] },
  'glm-5.2': { canDisableThinking: true, reasoningEffortValues: ['high', 'max'] },
  'glm-4.7': { canDisableThinking: true },
  'glm-4.7-flash': { canDisableThinking: true },
  'glm-4.5': { canDisableThinking: true },
  'glm-4.5-air': { canDisableThinking: true },
  'glm-4.5-x': { canDisableThinking: true },
}

export function glmModelCapabilities(model: string | undefined): GlmModelCapabilities {
  return (model && GLM_MODEL_CAPABILITIES[model]) || { canDisableThinking: true }
}

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
    'Whether GLM uses extended reasoning ("thinking") before responding. z.ai only supports on/off, not graduated effort levels. Has no effect on GLM-5.3, which cannot disable thinking at all — use Reasoning effort instead for that model.',
  secret: false,
  type: 'select',
  options: THINKING_OPTIONS,
}

const reasoningEffortField: PluginSettingField = {
  key: 'reasoningEffort',
  label: 'Reasoning effort',
  description:
    'How deep GLM\'s reasoning goes when thinking is on — only documented for GLM-5.2 (high/max) and GLM-5.3 (low/high/max, always on). Ignored for GLM-4.7 and older, which don\'t support this parameter. Lower effort trades reasoning depth for speed.',
  secret: false,
  type: 'select',
  options: REASONING_EFFORT_OPTIONS,
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
    reasoningEffortField,
  ],
  personaOverridableFields: [modelField, thinkingField, reasoningEffortField],
}
