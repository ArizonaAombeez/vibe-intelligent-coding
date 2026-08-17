import { test } from 'node:test'
import assert from 'node:assert/strict'
import { settingsManifest, KNOWN_CLAUDE_CODE_MODELS, EFFORT_OPTIONS } from '../src/index.js'

test('settingsManifest declares a stable plugin id and no secret fields', () => {
  assert.equal(settingsManifest.id, 'vic-llm-claude-code')
  assert.ok(!settingsManifest.fields.some((f) => f.secret), 'auth is the CLI\'s own OAuth login, not a stored secret')
})

test('settingsManifest setup summary explains the CLI + Pro/Max requirement', () => {
  assert.match(settingsManifest.setupSummary, /CLI/i)
  assert.match(settingsManifest.setupSummary, /Pro|Max/)
})

test('model field is a select with a curated option list including a CLI-default option', () => {
  const modelField = settingsManifest.fields.find((f) => f.key === 'model')
  assert.ok(modelField)
  assert.equal(modelField?.type, 'select')
  assert.deepEqual(modelField?.options, KNOWN_CLAUDE_CODE_MODELS)
  assert.ok(modelField?.options?.some((o) => o.value === ''))
})

test('effort field is a select with a curated option list including a CLI-default option', () => {
  const effortField = settingsManifest.fields.find((f) => f.key === 'effort')
  assert.ok(effortField)
  assert.equal(effortField?.type, 'select')
  assert.deepEqual(effortField?.options, EFFORT_OPTIONS)
  assert.ok(effortField?.options?.some((o) => o.value === ''))
})

test('model and effort are persona-overridable', () => {
  const keys = settingsManifest.personaOverridableFields.map((f) => f.key)
  assert.deepEqual(keys, ['model', 'effort'])
})
