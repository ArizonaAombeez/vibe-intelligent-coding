import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computePhaseReadiness,
  setArchitectureType,
  createArchitectureElement,
  reassignArchitectureElement,
  createRequirementFromForm,
} from '../src/index.js'
import type { Project } from '../src/index.js'

function emptyProject(): Project {
  return {
    schemaVersion: 3,
    id: 'proj-1',
    name: 'Test',
    projectMode: 'new',
    requirements: [],
  }
}

test('computePhaseReadiness: a bare project has requirements not-started and everything downstream not-started', () => {
  const r = computePhaseReadiness(emptyProject())
  assert.equal(r.statuses.requirements, 'not-started')
  assert.equal(r.statuses.architecture, 'not-started')
  assert.equal(r.statuses.coding, 'not-started')
  assert.equal(r.blockers.length, 0)
})

test('computePhaseReadiness: requirements go in-progress with an unallocated requirement, complete once all allocated', () => {
  const project = emptyProject()
  setArchitectureType(project, 'custom')
  const el = createArchitectureElement(project, {
    kind: 'functional',
    name: 'Engine',
    responsibility: 'Runs the loop',
    row: 0,
    col: 0,
  })
  const req = createRequirementFromForm(project, { text: 'The system shall run' }, 1)
  assert.equal(computePhaseReadiness(project).statuses.requirements, 'in-progress')

  reassignArchitectureElement(project, req.id, el.id)
  assert.equal(computePhaseReadiness(project).statuses.requirements, 'complete')
})

test('computePhaseReadiness: architecture with elements but no platform is in-progress with a "choose a platform" blocker', () => {
  const project = emptyProject()
  setArchitectureType(project, 'custom')
  createArchitectureElement(project, {
    kind: 'functional',
    name: 'Engine',
    responsibility: 'Runs the loop',
    row: 0,
    col: 0,
  })
  createRequirementFromForm(project, { text: 'The system shall run' }, 1)

  const r = computePhaseReadiness(project)
  assert.equal(r.statuses.architecture, 'in-progress')
  const blocker = r.blockers.find((b) => b.phaseId === 'architecture')
  assert.ok(blocker, 'there is an architecture blocker')
  assert.match(blocker.reason, /platform/i)
  assert.equal(blocker.fixPhaseId, 'architecture')
})

test('computePhaseReadiness: platform set but harness never derived yields a "Define Harness" blocker', () => {
  const project = emptyProject()
  setArchitectureType(project, 'custom')
  createArchitectureElement(project, {
    kind: 'functional',
    name: 'Engine',
    responsibility: 'Runs the loop',
    row: 0,
    col: 0,
  })
  project.platform = 'web'

  const r = computePhaseReadiness(project)
  const blocker = r.blockers.find((b) => b.phaseId === 'architecture')
  assert.ok(blocker)
  assert.match(blocker.reason, /Harness has not been derived/i)
})

test('computePhaseReadiness: test-creation blocks when a test case has no generated file', () => {
  const project = emptyProject()
  project.testSuite = {
    nextTestSeq: 3,
    tests: [
      { id: 'TEST-001', type: 'functional', title: 'a', requirementIds: ['R1'], architectureElementId: 'ARCH-1', status: 'not-run', createdAt: new Date().toISOString(), filePath: 'engine/a.test.mjs' },
      { id: 'TEST-002', type: 'functional', title: 'b', requirementIds: ['R2'], architectureElementId: 'ARCH-1', status: 'not-run', createdAt: new Date().toISOString() },
    ],
  }
  const r = computePhaseReadiness(project)
  assert.equal(r.statuses['test-creation'], 'in-progress')
  const blocker = r.blockers.find((b) => b.phaseId === 'test-creation')
  assert.ok(blocker)
  assert.match(blocker.reason, /no generated automation/i)
})

test('computePhaseReadiness: coding is blocked when any run is success-tests-failing', () => {
  const project = emptyProject()
  setArchitectureType(project, 'custom')
  const el = createArchitectureElement(project, {
    kind: 'functional',
    name: 'Engine',
    responsibility: 'r',
    row: 0,
    col: 0,
  })
  project.codingRuns = [
    {
      id: 'CR-1',
      architectureElementId: el.id,
      startedAt: '2026-01-01T00:00:00Z',
      finishedAt: '2026-01-01T00:01:00Z',
      status: 'success-tests-failing',
      diff: 'x',
      rawLog: '',
      exitCode: 0,
      allowedSubfolder: 'engine',
    },
  ]
  assert.equal(computePhaseReadiness(project).statuses.coding, 'blocked')
})

test('computePhaseReadiness: a full regression over zero outcomes does not mark test-execution complete', () => {
  const project = emptyProject()
  project.testRuns = [{ id: 'TR-1', kind: 'element-scoped', architectureElementId: 'ARCH-1', startedAt: 'x', finishedAt: 'y', exitCode: null, rawLog: '', outcomes: [], swOutcomes: [] }]
  project.testRegressionRuns = [
    { id: 'REG-1', startedAt: 'x', finishedAt: 'y', runIds: ['TR-1'], allPassed: false, outcomeCount: 0, trigger: 'manual' },
  ]
  // no outcomes anywhere -> still 'not-started' (coding isn't complete either)
  assert.equal(computePhaseReadiness(project).statuses['test-execution'], 'not-started')
})
