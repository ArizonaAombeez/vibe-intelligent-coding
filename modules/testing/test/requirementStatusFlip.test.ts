import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyPassThreshold } from '../src/index.js'
import type { Project, Requirement, TestCase, TestCaseOutcome } from 'vic-requirements-elicitation'

function baseProject(requirementStatus: Requirement['status']): Project {
  return {
    schemaVersion: 1,
    id: 'proj-1',
    name: 'Test',
    projectMode: 'new',
    requirements: [
      {
        id: 'REQ-001',
        text: 'The system shall render a login form',
        type: null,
        status: requirementStatus,
        createdAt: new Date().toISOString(),
        provenance: 'human',
        architectureElements: ['ARCH-001'],
      },
    ],
  }
}

function functionalTest(): TestCase {
  return {
    id: 'TEST-001',
    type: 'functional',
    title: 'Renders login form',
    requirementIds: ['REQ-001'],
    architectureElementId: 'ARCH-001',
    status: 'not-run',
    createdAt: new Date().toISOString(),
  }
}

function outcome(passed: boolean, extra: Partial<TestCaseOutcome> = {}): TestCaseOutcome {
  return { testCaseId: 'TEST-001', passed, output: '', ...extra }
}

test('all-pass first time flips a coded requirement to tested', () => {
  const project = baseProject('coded')
  const result = applyPassThreshold(project, [functionalTest()], [outcome(true)], false)

  assert.deepEqual(result.flippedToTested, ['REQ-001'])
  assert.equal(project.requirements[0].status, 'tested')
})

test('all-pass full-regression after tested flips to complete', () => {
  const project = baseProject('tested')
  const result = applyPassThreshold(project, [functionalTest()], [outcome(true)], true)

  assert.deepEqual(result.flippedToComplete, ['REQ-001'])
  assert.equal(project.requirements[0].status, 'complete')
})

test('all-pass but not full regression does not flip a tested requirement to complete', () => {
  const project = baseProject('tested')
  const result = applyPassThreshold(project, [functionalTest()], [outcome(true)], false)

  assert.deepEqual(result.flippedToComplete, [])
  assert.equal(project.requirements[0].status, 'tested', 'complete only ever happens on a full regression pass')
})

test('any-fail from complete regresses to tested-fail, once triaged as code-failure', () => {
  const project = baseProject('complete')
  const failing = outcome(false, { triage: 'code-failure', triageRationale: 'bug' })
  const result = applyPassThreshold(project, [functionalTest()], [failing], true)

  assert.deepEqual(result.regressed, ['REQ-001'])
  assert.equal(project.requirements[0].status, 'tested-fail')
})

test('a failing test with no triage yet leaves requirement status completely unchanged', () => {
  const project = baseProject('complete')
  const failing = outcome(false) // no triage field at all -> unattributed
  const result = applyPassThreshold(project, [functionalTest()], [failing], true)

  assert.deepEqual(result.regressed, [])
  assert.deepEqual(result.flippedToTested, [])
  assert.deepEqual(result.flippedToComplete, [])
  assert.equal(project.requirements[0].status, 'complete', 'status must not change until triage completes')
})

test('a failing test triaged test-case-failure but not human-confirmed still holds the status change', () => {
  const project = baseProject('tested')
  const failing = outcome(false, { triage: 'test-case-failure', triageRationale: 'bad assertion' })
  const result = applyPassThreshold(project, [functionalTest()], [failing], false)

  assert.deepEqual(result.regressed, [])
  assert.equal(project.requirements[0].status, 'tested')
})

test('a requirement with zero outcomes in this run is left untouched', () => {
  const project = baseProject('coded')
  const otherTest: TestCase = { ...functionalTest(), id: 'TEST-002', requirementIds: ['REQ-999'] }
  const result = applyPassThreshold(project, [otherTest], [outcome(true, { testCaseId: 'TEST-002' })], false)

  assert.deepEqual(result.flippedToTested, [])
  assert.equal(project.requirements[0].status, 'coded', 'no evidence either way must never be conflated with passed')
})

test('an integration test outcome counts toward every requirement on either side of the interface', () => {
  const project: Project = {
    schemaVersion: 1,
    id: 'proj-1',
    name: 'Test',
    projectMode: 'new',
    requirements: [
      {
        id: 'REQ-001',
        text: 'req a',
        type: null,
        status: 'coded',
        createdAt: new Date().toISOString(),
        provenance: 'human',
        architectureElements: ['ARCH-001'],
      },
      {
        id: 'REQ-002',
        text: 'req b',
        type: null,
        status: 'coded',
        createdAt: new Date().toISOString(),
        provenance: 'human',
        architectureElements: ['ARCH-002'],
      },
    ],
  }
  const integrationTest: TestCase = {
    id: 'TEST-INT-001',
    type: 'integration',
    title: 'Charges the card',
    requirementIds: [],
    interfaceDefinitionId: 'IFACE-001',
    architectureElementId: null,
    interfaceElementIds: ['ARCH-001', 'ARCH-002'],
    status: 'not-run',
    createdAt: new Date().toISOString(),
  }

  const result = applyPassThreshold(
    project,
    [integrationTest],
    [outcome(true, { testCaseId: 'TEST-INT-001' })],
    false,
  )

  assert.deepEqual(result.flippedToTested.sort(), ['REQ-001', 'REQ-002'])
})
