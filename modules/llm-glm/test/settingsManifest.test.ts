import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  settingsManifest,
  KNOWN_GLM_MODELS,
  THINKING_OPTIONS,
  ACCESS_METHOD_OPTIONS,
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

test('personaOverridableFields exposes model/thinking but never the apiKey secret or accessMethod', () => {
  const keys = settingsManifest.personaOverridableFields.map((f) => f.key)
  assert.deepEqual(keys.sort(), ['model', 'thinking'])
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
