import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getProjectSettings, updateProjectSettings } from '../src/index.js'
import type { Project } from '../src/index.js'

function emptyProject(): Project {
  return {
    schemaVersion: 1,
    id: 'proj-1',
    name: 'Test Project',
    projectMode: 'new',
    requirements: [],
  }
}

test('getProjectSettings defaults to always-accessible for a project with no settings saved yet', () => {
  const project = emptyProject()
  assert.deepEqual(getProjectSettings(project), { phaseTabGating: 'always-accessible' })
})

test('updateProjectSettings persists a change and getProjectSettings reflects it', () => {
  const project = emptyProject()
  updateProjectSettings(project, { phaseTabGating: 'gated' })

  assert.deepEqual(getProjectSettings(project), { phaseTabGating: 'gated' })
  assert.deepEqual(project.settings, { phaseTabGating: 'gated' })
})

test('updateProjectSettings merges partial updates on top of existing settings', () => {
  const project = emptyProject()
  updateProjectSettings(project, { phaseTabGating: 'gated' })
  updateProjectSettings(project, {})

  assert.deepEqual(project.settings, { phaseTabGating: 'gated' }, 'an empty update must not reset to defaults')
})
