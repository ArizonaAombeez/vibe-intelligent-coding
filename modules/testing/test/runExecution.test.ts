import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scaffoldProjectSourceTree, sourceTreeRoot } from 'vic-coding'
import type { Project, Requirement, TestCase } from 'vic-requirements-elicitation'
import { createTestCase } from 'vic-requirements-elicitation'
import {
  runElementTestSuite,
  runFullRegression,
  writeElementTestCommand,
  evaluateRequirementStatus,
  evaluateRequirementStatusForRegression,
} from '../src/index.js'

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-test-runner.mjs')

async function tempProjectDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'vic-runexecution-test-'))
}

function baseProject(requirementStatus: Requirement['status'] = 'coded'): Project {
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
    architecture: {
      layers: ['Core'],
      elements: [{ id: 'ARCH-001', kind: 'functional', name: 'Login UI', responsibility: 'Renders login', row: 0, col: 0, rowSpan: 1, colSpan: 1, interfaces: [] }],
      nextElementSeq: 2,
    },
  }
}

async function setUpProjectWithTest(mode: string): Promise<{ dir: string; project: Project; testCase: TestCase }> {
  process.env.FAKE_TEST_MODE = mode
  const dir = await tempProjectDir()
  const project = baseProject()
  await scaffoldProjectSourceTree(project, dir)
  await writeElementTestCommand(sourceTreeRoot(dir), 'login-ui', { command: 'node', args: [fixture] })
  const { testCase } = createTestCase(project, {
    type: 'functional',
    title: 'Renders login form',
    requirementIds: ['REQ-001'],
    architectureElementId: 'ARCH-001',
  })
  // attributeOutcomes (runExecution.ts) only attributes an outcome to a
  // TestCase with filePath set — a real test file already exists in the
  // scaffolded source tree here (fake-test-runner.mjs stands in for it via
  // writeElementTestCommand above), so this simulates that generation
  // already happened, same as generateTestFileForTestCase would have set.
  testCase!.filePath = 'login-ui/login.test.ts'
  process.env.FAKE_TEST_TITLES = testCase!.title
  return { dir, project, testCase: testCase! }
}

test('runElementTestSuite: an all-pass run flips a coded requirement to tested', async () => {
  const { dir, project } = await setUpProjectWithTest('all-pass')
  try {
    const run = await runElementTestSuite(project, dir, { architectureElementId: 'ARCH-001' })

    assert.equal(run.exitCode, 0)
    assert.equal(run.outcomes[0].passed, true)
    assert.equal(project.requirements[0].status, 'tested')
  } finally {
    await rm(dir, { recursive: true, force: true })
    delete process.env.FAKE_TEST_TITLES
  }
})

test('runFullRegression after tested flips the requirement to complete', async () => {
  const { dir, project } = await setUpProjectWithTest('all-pass')
  try {
    await runElementTestSuite(project, dir, { architectureElementId: 'ARCH-001' })
    assert.equal(project.requirements[0].status, 'tested')

    const regression = await runFullRegression(project, dir, 'manual')

    assert.equal(regression.allPassed, true)
    assert.equal(project.requirements[0].status, 'complete')
  } finally {
    await rm(dir, { recursive: true, force: true })
    delete process.env.FAKE_TEST_TITLES
  }
})

test('a regression run introducing a failure holds status until triaged, then re-evaluating the same run regresses it to tested-fail', async () => {
  const { dir, project } = await setUpProjectWithTest('all-pass')
  try {
    await runElementTestSuite(project, dir, { architectureElementId: 'ARCH-001' })
    await runFullRegression(project, dir, 'manual')
    assert.equal(project.requirements[0].status, 'complete')

    // The implementation regresses (mode flips to all-fail). The
    // regression pass that first sees the new failure has no triage yet,
    // so status must be held at 'complete' even though a test just failed.
    process.env.FAKE_TEST_MODE = 'all-fail'
    const regression = await runFullRegression(project, dir, 'manual')
    assert.equal(regression.allPassed, false)
    assert.equal(project.requirements[0].status, 'complete', 'held until triage completes')

    // Triage happens out-of-band (simulating the real triageTestFailure
    // flow) against that same regression pass's already-recorded outcome —
    // status flips are decoupled from running tests specifically so this
    // can happen after the fact without re-running anything.
    const failingOutcome = regression.runIds
      .map((id) => project.testRuns!.find((r) => r.id === id)!)
      .flatMap((r) => r.outcomes)
      .find((o) => !o.passed)
    assert.ok(failingOutcome)
    failingOutcome!.triage = 'code-failure'

    // Re-evaluating that SAME regression pass (no new test run) now finds
    // the failure triaged, so the gate lets the regression through.
    evaluateRequirementStatusForRegression(project, regression)

    assert.equal(project.requirements[0].status, 'tested-fail')
  } finally {
    await rm(dir, { recursive: true, force: true })
    delete process.env.FAKE_TEST_TITLES
  }
})

test('evaluateRequirementStatus re-evaluates a single element-scoped run after triage without re-running tests', async () => {
  const { dir, project } = await setUpProjectWithTest('all-fail')
  try {
    const run = await runElementTestSuite(project, dir, { architectureElementId: 'ARCH-001' })
    assert.equal(project.requirements[0].status, 'coded', 'held — untriaged failure')

    run.outcomes[0].triage = 'code-failure'
    const result = evaluateRequirementStatus(project, run, false)

    assert.deepEqual(result.regressed, [], 'a coded requirement cannot regress further')
    assert.equal(project.requirements[0].status, 'coded')
  } finally {
    await rm(dir, { recursive: true, force: true })
    delete process.env.FAKE_TEST_TITLES
  }
})

test('a failing test with no triage yet leaves requirement status completely unchanged', async () => {
  const { dir, project } = await setUpProjectWithTest('all-fail')
  try {
    const before = project.requirements[0].status
    await runElementTestSuite(project, dir, { architectureElementId: 'ARCH-001' })

    assert.equal(project.requirements[0].status, before, 'status must not change until triage completes')
  } finally {
    await rm(dir, { recursive: true, force: true })
    delete process.env.FAKE_TEST_TITLES
  }
})

test('runElementTestSuite: a test case with no generated file is left untouched, not inheriting the aggregate outcome of a real test in the same scope', async () => {
  // Deliberately does NOT reuse setUpProjectWithTest — needs two test cases
  // in the same scope, only one of which has filePath set, to reproduce
  // the exact real-world bug this guard fixes: running one generated
  // test's command previously marked every OTHER (never-generated) test
  // case in the same element as passing too, via attributeOutcomes' whole-
  // scope aggregate fallback.
  process.env.FAKE_TEST_MODE = 'nonzero-exit' // no parseable per-test lines -> forces the aggregate-fallback path
  const dir = await tempProjectDir()
  try {
    const project = baseProject()
    await scaffoldProjectSourceTree(project, dir)
    await writeElementTestCommand(sourceTreeRoot(dir), 'login-ui', { command: 'node', args: [fixture] })

    const { testCase: generatedTest } = createTestCase(project, {
      type: 'functional',
      title: 'Renders login form',
      requirementIds: ['REQ-001'],
      architectureElementId: 'ARCH-001',
    })
    generatedTest!.filePath = 'login-ui/login.test.ts'

    const { testCase: ungeneratedTest } = createTestCase(project, {
      type: 'functional',
      title: 'Shows a validation error on bad input',
      requirementIds: ['REQ-001'],
      architectureElementId: 'ARCH-001',
    })
    assert.equal(ungeneratedTest!.filePath, undefined)
    const ungeneratedStatusBefore = ungeneratedTest!.status

    const run = await runElementTestSuite(project, dir, { architectureElementId: 'ARCH-001' })

    assert.equal(run.exitCode, 1)
    assert.deepEqual(
      run.outcomes.map((o) => o.testCaseId),
      [generatedTest!.id],
      'only the test case with a generated file gets an outcome',
    )
    assert.equal(generatedTest!.status, 'failing')
    assert.equal(
      ungeneratedTest!.status,
      ungeneratedStatusBefore,
      'a never-generated test case must not inherit the aggregate outcome',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
    delete process.env.FAKE_TEST_TITLES
  }
})

test('runElementTestSuite rejects a scope that has never been scaffolded, without spawning a subprocess', async () => {
  const dir = await tempProjectDir()
  try {
    const project = baseProject()
    // No scaffold call — element subfolder does not exist on disk yet.
    const run = await runElementTestSuite(project, dir, { architectureElementId: 'ARCH-001' })

    assert.deepEqual(run.outcomes, [])
    assert.equal(run.exitCode, null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
