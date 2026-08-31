import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { scaffoldProjectSourceTree, sourceTreeRoot } from 'vic-coding'
import type { Project, Requirement, TestCase } from 'vic-requirements-elicitation'
import { createTestCase } from 'vic-requirements-elicitation'
import {
  runElementTestSuite,
  runFullRegression,
  evaluateRequirementStatus,
  evaluateRequirementStatusForRegression,
} from '../src/index.js'

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
      elements: [{ id: 'ARCH-001', kind: 'functional', name: 'Login UI', responsibility: 'Renders login', row: 0, col: 0, rowSpan: 1, colSpan: 1, interfaces: [], elementInterfaces: [] }],
      nextElementSeq: 2,
      nextInterfaceSeq: 1,
    },
  }
}

// Writes a real, directly-runnable *.test.mjs file under an element's own
// scaffolded subfolder — runElementTestSuite (runExecution.ts) discovers
// and runs every such file individually by extension (no shared per-element
// command, no output-line parsing), exactly mirroring what a real
// LLM-written test file looks like (see Worm Game's actual generated
// tests): plain script, `process.exitCode` decides pass/fail, nothing to
// declare or configure beforehand.
async function writeTestFile(srcRoot: string, relativeDir: string, fileName: string, passes: boolean): Promise<void> {
  const dir = path.join(srcRoot, relativeDir)
  await mkdir(dir, { recursive: true })
  const body = passes
    ? `console.log('Test passed: ${fileName}');\n`
    : `console.log('Test failed: ${fileName}');\nprocess.exitCode = 1;\n`
  await writeFile(path.join(dir, fileName), body, 'utf-8')
}

async function setUpProjectWithTest(passes: boolean): Promise<{ dir: string; project: Project; testCase: TestCase }> {
  const dir = await tempProjectDir()
  const project = baseProject()
  await scaffoldProjectSourceTree(project, dir)
  const srcRoot = sourceTreeRoot(dir)
  await writeTestFile(srcRoot, 'login-ui', 'login.test.mjs', passes)
  const { testCase } = createTestCase(project, {
    type: 'functional',
    title: 'Renders login form',
    requirementIds: ['REQ-001'],
    architectureElementId: 'ARCH-001',
  })
  // attributeResults (runExecution.ts) only attributes an outcome to a
  // TestCase with filePath set — matching against the real file just
  // written above, same convention generateTestFileForTestCase uses.
  testCase!.filePath = 'login-ui/login.test.mjs'
  return { dir, project, testCase: testCase! }
}

test('runElementTestSuite: an all-pass run flips a coded requirement to tested', async () => {
  const { dir, project } = await setUpProjectWithTest(true)
  try {
    const run = await runElementTestSuite(project, dir, { architectureElementId: 'ARCH-001' })

    assert.equal(run.exitCode, 0)
    assert.equal(run.outcomes[0].passed, true)
    assert.equal(project.requirements[0].status, 'tested')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runFullRegression after tested flips the requirement to complete', async () => {
  const { dir, project } = await setUpProjectWithTest(true)
  try {
    await runElementTestSuite(project, dir, { architectureElementId: 'ARCH-001' })
    assert.equal(project.requirements[0].status, 'tested')

    const regression = await runFullRegression(project, dir, 'manual')

    assert.equal(regression.allPassed, true)
    assert.equal(project.requirements[0].status, 'complete')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a regression run introducing a failure holds status until triaged, then re-evaluating the same run regresses it to tested-fail', async () => {
  const { dir, project } = await setUpProjectWithTest(true)
  try {
    await runElementTestSuite(project, dir, { architectureElementId: 'ARCH-001' })
    await runFullRegression(project, dir, 'manual')
    assert.equal(project.requirements[0].status, 'complete')

    // The implementation regresses — rewrite the same file to now fail. The
    // regression pass that first sees the new failure has no triage yet,
    // so status must be held at 'complete' even though a test just failed.
    await writeTestFile(sourceTreeRoot(dir), 'login-ui', 'login.test.mjs', false)
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
  }
})

test('evaluateRequirementStatus re-evaluates a single element-scoped run after triage without re-running tests', async () => {
  const { dir, project } = await setUpProjectWithTest(false)
  try {
    const run = await runElementTestSuite(project, dir, { architectureElementId: 'ARCH-001' })
    assert.equal(project.requirements[0].status, 'coded', 'held — untriaged failure')

    run.outcomes[0].triage = 'code-failure'
    const result = evaluateRequirementStatus(project, run, false)

    assert.deepEqual(result.regressed, [], 'a coded requirement cannot regress further')
    assert.equal(project.requirements[0].status, 'coded')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a failing test with no triage yet leaves requirement status completely unchanged', async () => {
  const { dir, project } = await setUpProjectWithTest(false)
  try {
    const before = project.requirements[0].status
    await runElementTestSuite(project, dir, { architectureElementId: 'ARCH-001' })

    assert.equal(project.requirements[0].status, before, 'status must not change until triage completes')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runElementTestSuite: a test case with no generated file is left untouched by another test file\'s outcome in the same scope', async () => {
  // Two TestCases in the same scope, only one of which has filePath (and a
  // real backing file) set — reproduces the exact real-world bug this
  // guard fixes: a never-generated test case must never inherit some other
  // file's pass/fail just because it shares the element.
  const dir = await tempProjectDir()
  try {
    const project = baseProject()
    await scaffoldProjectSourceTree(project, dir)
    await writeTestFile(sourceTreeRoot(dir), 'login-ui', 'login.test.mjs', false)

    const { testCase: generatedTest } = createTestCase(project, {
      type: 'functional',
      title: 'Renders login form',
      requirementIds: ['REQ-001'],
      architectureElementId: 'ARCH-001',
    })
    generatedTest!.filePath = 'login-ui/login.test.mjs'

    const { testCase: ungeneratedTest } = createTestCase(project, {
      type: 'functional',
      title: 'Shows a validation error on bad input',
      requirementIds: ['REQ-001'],
      architectureElementId: 'ARCH-001',
    })
    assert.equal(ungeneratedTest!.filePath, undefined)
    const ungeneratedStatusBefore = ungeneratedTest!.status

    const run = await runElementTestSuite(project, dir, { architectureElementId: 'ARCH-001' })

    assert.deepEqual(
      run.outcomes.map((o) => o.testCaseId),
      [generatedTest!.id],
      'only the test case with a generated (and matched) file gets an outcome',
    )
    assert.equal(generatedTest!.status, 'failing')
    assert.equal(
      ungeneratedTest!.status,
      ungeneratedStatusBefore,
      'a never-generated test case must not inherit another file\'s outcome',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runElementTestSuite: a test case whose recorded file was deleted is reset to not-run and recorded in run.missingFiles', async () => {
  const { dir, project, testCase } = await setUpProjectWithTest(true)
  try {
    // First run: file exists, produces a real passing outcome.
    const first = await runElementTestSuite(project, dir, { architectureElementId: 'ARCH-001' })
    assert.equal(first.outcomes[0]?.passed, true)
    assert.equal(testCase.status, 'passing')

    // The source tree is re-coded and the generated test file is lost, but
    // the TestCase record still points at it.
    await rm(path.join(sourceTreeRoot(dir), 'login-ui', 'login.test.mjs'), { force: true })

    const run = await runElementTestSuite(project, dir, { architectureElementId: 'ARCH-001' })

    assert.deepEqual(
      run.missingFiles,
      [{ testCaseId: testCase.id, filePath: 'login-ui/login.test.mjs' }],
      'the vanished file is recorded on the run',
    )
    assert.equal(testCase.filePath, undefined, 'the dead pointer is cleared')
    assert.equal(testCase.status, 'not-run', 'the test case is reset, not left stale-passing')
    assert.deepEqual(run.outcomes, [], 'no outcome is fabricated for a test whose file is gone')
    assert.match(run.rawLog, /recorded but missing from disk/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runElementTestSuite: harness scope discovers test files at the source-tree root, not just inside _harness/', async () => {
  const dir = await tempProjectDir()
  try {
    const project = baseProject()
    project.architecture!.elements.push({
      id: 'ARCH-HARNESS',
      kind: 'harness',
      name: 'Harness',
      responsibility: 'Composition root',
      row: 0,
      col: 2,
      rowSpan: 1,
      colSpan: 1,
      interfaces: [],
      elementInterfaces: [],
    })
    await scaffoldProjectSourceTree(project, dir)
    const srcRoot = sourceTreeRoot(dir)
    // A cross-cutting test the harness run wrote next to the entry point,
    // not inside its own (docs-only) _harness/ folder.
    await writeFile(path.join(srcRoot, 'app-boot.test.mjs'), `console.log('boot ok');\n`, 'utf-8')

    const run = await runElementTestSuite(project, dir, { architectureElementId: 'ARCH-HARNESS' })

    assert.deepEqual(
      run.swOutcomes,
      [{ name: 'app-boot.test.mjs', passed: true }],
      'the root-level harness test is discovered and run',
    )
    assert.equal(run.exitCode, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
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

test('runElementTestSuite reports a test file with no matching TestCase as an SW outcome, not a requirement-traced one', async () => {
  const { dir, project, testCase } = await setUpProjectWithTest(true)
  try {
    // The coding agent's own inline test file, alongside the one real
    // requirement-traced TestCase already set up by setUpProjectWithTest —
    // never registered via Test Creation, so it has no TestCase/filePath
    // link at all.
    await writeTestFile(sourceTreeRoot(dir), 'login-ui', 'edge-cases.test.mjs', true)

    const run = await runElementTestSuite(project, dir, { architectureElementId: 'ARCH-001' })

    assert.deepEqual(
      run.outcomes.map((o) => o.testCaseId),
      [testCase.id],
      'the known TestCase still gets its own requirement-traced outcome',
    )
    assert.deepEqual(
      run.swOutcomes,
      [{ name: 'edge-cases.test.mjs', passed: true }],
      'the untraced file is reported separately as an SW outcome, not folded into outcomes',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runFullRegression sweeps an architecture element with no requirement-based TestCases at all, so its SW tests still run', async () => {
  const dir = await tempProjectDir()
  try {
    const project = baseProject()
    // Second element with zero TestCases — only SW-based (coding-agent)
    // tests live here.
    project.architecture!.elements.push({
      id: 'ARCH-002',
      kind: 'functional',
      name: 'Game Engine',
      responsibility: 'Runs the game loop',
      row: 0,
      col: 1,
      rowSpan: 1,
      colSpan: 1,
      interfaces: [],
      elementInterfaces: [],
    })
    await scaffoldProjectSourceTree(project, dir)
    await writeTestFile(sourceTreeRoot(dir), 'game-engine', 'tick.test.mjs', true)

    const regression = await runFullRegression(project, dir, 'manual')

    const swRun = regression.runIds
      .map((id) => project.testRuns!.find((r) => r.id === id)!)
      .find((r) => r.architectureElementId === 'ARCH-002')
    assert.ok(swRun, 'the zero-TestCase element still got its own element-scoped run')
    assert.deepEqual(swRun!.outcomes, [], 'no requirement-traced outcomes, since it has no TestCase')
    assert.deepEqual(swRun!.swOutcomes, [{ name: 'tick.test.mjs', passed: true }])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runElementTestSuite: only:"requirement" runs only the TestCase-owned file and carries SW outcomes forward', async () => {
  const dir = await tempProjectDir()
  const project = baseProject()
  await scaffoldProjectSourceTree(project, dir)
  const srcRoot = sourceTreeRoot(dir)
  // Two files in the same element scope: one owned by a TestCase, one not.
  await writeTestFile(srcRoot, 'login-ui', 'login.test.mjs', true)
  await writeTestFile(srcRoot, 'login-ui', 'coding-agent-extra.test.mjs', true)
  const { testCase } = createTestCase(project, {
    type: 'functional',
    title: 'Renders login form',
    requirementIds: ['REQ-001'],
    architectureElementId: 'ARCH-001',
  })
  testCase!.filePath = 'login-ui/login.test.mjs'
  try {
    // First: an unfiltered run establishes both columns.
    const full = await runElementTestSuite(project, dir, { architectureElementId: 'ARCH-001' })
    assert.equal(full.outcomes.length, 1)
    assert.deepEqual(
      full.swOutcomes!.map((o) => o.name).sort(),
      ['coding-agent-extra.test.mjs'],
    )

    // Now break the SW-only file and run only:"requirement" — it must NOT
    // run the broken file, and must carry the previous SW outcome forward.
    await writeTestFile(srcRoot, 'login-ui', 'coding-agent-extra.test.mjs', false)
    const reqOnly = await runElementTestSuite(project, dir, { architectureElementId: 'ARCH-001', only: 'requirement' })
    assert.equal(reqOnly.outcomes.length, 1)
    assert.equal(reqOnly.outcomes[0].passed, true)
    assert.deepEqual(reqOnly.swOutcomes, [{ name: 'coding-agent-extra.test.mjs', passed: true }], 'SW column carried forward, broken file not re-run')
    assert.doesNotMatch(reqOnly.rawLog, /coding-agent-extra/, 'the SW-only file was not executed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runElementTestSuite: only:"sw" runs only non-TestCase files and carries requirement outcomes forward', async () => {
  const dir = await tempProjectDir()
  const project = baseProject()
  await scaffoldProjectSourceTree(project, dir)
  const srcRoot = sourceTreeRoot(dir)
  await writeTestFile(srcRoot, 'login-ui', 'login.test.mjs', true)
  await writeTestFile(srcRoot, 'login-ui', 'coding-agent-extra.test.mjs', true)
  const { testCase } = createTestCase(project, {
    type: 'functional',
    title: 'Renders login form',
    requirementIds: ['REQ-001'],
    architectureElementId: 'ARCH-001',
  })
  testCase!.filePath = 'login-ui/login.test.mjs'
  try {
    await runElementTestSuite(project, dir, { architectureElementId: 'ARCH-001' })

    // Break the requirement file, run only:"sw" — requirement outcome must
    // be carried forward as passing, and the broken file not re-run.
    await writeTestFile(srcRoot, 'login-ui', 'login.test.mjs', false)
    const swOnly = await runElementTestSuite(project, dir, { architectureElementId: 'ARCH-001', only: 'sw' })
    assert.deepEqual(swOnly.swOutcomes, [{ name: 'coding-agent-extra.test.mjs', passed: true }])
    assert.equal(swOnly.outcomes.length, 1)
    assert.equal(swOnly.outcomes[0].passed, true, 'requirement outcome carried forward')
    assert.doesNotMatch(swOnly.rawLog, /login\.test\.mjs/, 'the requirement file was not executed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
