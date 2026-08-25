import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  settingsManifest,
  KNOWN_GLM_MODELS,
  THINKING_OPTIONS,
  REASONING_EFFORT_OPTIONS,
  ACCESS_METHOD_OPTIONS,
  GLM_MODEL_CAPABILITIES,
  glmModelCapabilities,
} from '../src/index.js'

test('settingsManifest declares a stable plugin id and an apiKey secret field', () => {
  assert.equal(settingsManifest.id, 'vic-llm-glm')
  const apiKeyField = settingsManifest.fields.find((f) => f.key === 'apiKey')
  assert.ok(apiKeyField, 'expected an apiKey field')
  assert.equal(apiKeyField?.secret, true)
  assert.ok(apiKeyField?.description.length > 0)
})

test('settingsManifest declares setup expectations (cloud API, no local install) and a signup URL', () => {
  assert.ok(settingsManifest.setupSummary.length > 0)
  assert.match(settingsManifest.setupSummary, /nothing to install/i)
  assert.equal(settingsManifest.setupUrl, 'https://z.ai/manage-apikey/apikey-list')
})

test('model field is a select with a curated, non-empty option list', () => {
  const modelField = settingsManifest.fields.find((f) => f.key === 'model')
  assert.ok(modelField)
  assert.equal(modelField?.type, 'select')
  assert.ok(modelField?.options && modelField.options.length > 0)
  assert.deepEqual(modelField?.options, KNOWN_GLM_MODELS)
})

test('thinking field is a select offering exactly enabled/disabled', () => {
  const thinkingField = settingsManifest.fields.find((f) => f.key === 'thinking')
  assert.ok(thinkingField)
  assert.equal(thinkingField?.type, 'select')
  assert.deepEqual(
    thinkingField?.options?.map((o) => o.value),
    ['enabled', 'disabled'],
  )
  assert.deepEqual(THINKING_OPTIONS.map((o) => o.value), ['enabled', 'disabled'])
})

test('personaOverridableFields exposes model/thinking/reasoningEffort but never the apiKey secret or accessMethod', () => {
  const keys = settingsManifest.personaOverridableFields.map((f) => f.key)
  assert.deepEqual(keys.sort(), ['model', 'reasoningEffort', 'thinking'])
  assert.ok(!keys.includes('apiKey'), 'apiKey must never be persona-overridable')
  assert.ok(
    !keys.includes('accessMethod'),
    'accessMethod is an account-level fact, not a per-call override',
  )
})

test('accessMethod field is a select offering coding-plan and payg, defaulting nothing implicitly', () => {
  const accessMethodField = settingsManifest.fields.find((f) => f.key === 'accessMethod')
  assert.ok(accessMethodField)
  assert.equal(accessMethodField?.type, 'select')
  assert.deepEqual(
    accessMethodField?.options?.map((o) => o.value).sort(),
    ['coding-plan', 'payg'],
  )
  assert.deepEqual(ACCESS_METHOD_OPTIONS.map((o) => o.value).sort(), ['coding-plan', 'payg'])
})

test('KNOWN_GLM_MODELS includes glm-5.3', () => {
  assert.ok(KNOWN_GLM_MODELS.some((o) => o.value === 'glm-5.3'))
})

test('reasoningEffort field is a select offering low/high/max', () => {
  const field = settingsManifest.fields.find((f) => f.key === 'reasoningEffort')
  assert.ok(field)
  assert.equal(field?.type, 'select')
  assert.deepEqual(
    field?.options?.map((o) => o.value).sort(),
    ['high', 'low', 'max'],
  )
  assert.deepEqual(REASONING_EFFORT_OPTIONS.map((o) => o.value).sort(), ['high', 'low', 'max'])
})

// GLM-5.3's headline behavior change vs 5.2 (per z.ai's own docs): thinking
// is mandatory and cannot be disabled at all. This is the fact the
// thinking:disabled speedup relied on for every other model — getting this
// wrong for 5.3 specifically would silently send a no-op field and leave a
// user believing they'd disabled reasoning when they hadn't.
test('glmModelCapabilities: glm-5.3 cannot disable thinking, glm-5.2 and older can', () => {
  assert.equal(glmModelCapabilities('glm-5.3').canDisableThinking, false)
  assert.equal(glmModelCapabilities('glm-5.2').canDisableThinking, true)
  assert.equal(glmModelCapabilities('glm-4.7').canDisableThinking, true)
  assert.equal(glmModelCapabilities('glm-4.5').canDisableThinking, true)
})

// reasoning_effort is only documented for the GLM-5.x line, with different
// accepted values per model (5.2: high/max only, no 'low'; 5.3: all three).
// Not documented at all for GLM-4.7 or older, so those models resolve to
// undefined (the field is omitted from the request, not sent with a guessed
// value) — see ZaiGlmClient.chat's gating.
test('glmModelCapabilities: reasoning_effort values are per-model, undefined where undocumented', () => {
  assert.deepEqual(glmModelCapabilities('glm-5.3').reasoningEffortValues, ['low', 'high', 'max'])
  assert.deepEqual(glmModelCapabilities('glm-5.2').reasoningEffortValues, ['high', 'max'])
  assert.equal(glmModelCapabilities('glm-4.7').reasoningEffortValues, undefined)
  assert.equal(glmModelCapabilities('glm-4.5').reasoningEffortValues, undefined)
})

test('glmModelCapabilities: an unknown/future model falls back to the common case (can disable thinking, no reasoning_effort)', () => {
  const capabilities = glmModelCapabilities('glm-6.0-hypothetical')
  assert.equal(capabilities.canDisableThinking, true)
  assert.equal(capabilities.reasoningEffortValues, undefined)
})

test('GLM_MODEL_CAPABILITIES has an entry for every model in KNOWN_GLM_MODELS', () => {
  for (const { value } of KNOWN_GLM_MODELS) {
    assert.ok(GLM_MODEL_CAPABILITIES[value], `expected a capabilities entry for ${value}`)
  }
})
