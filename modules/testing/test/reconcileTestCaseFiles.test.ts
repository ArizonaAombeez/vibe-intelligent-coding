import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { scaffoldProjectSourceTree, sourceTreeRoot } from 'vic-coding'
import type { Project } from 'vic-requirements-elicitation'
import { createTestCase } from 'vic-requirements-elicitation'
import { reconcileTestCaseFiles } from '../src/index.js'

async function tempProjectDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'vic-reconcile-test-'))
}

function baseProject(): Project {
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
        status: 'coded',
        createdAt: new Date().toISOString(),
        provenance: 'human',
        architectureElements: ['ARCH-001'],
      },
    ],
    architecture: {
      layers: ['Core'],
      elements: [
        {
          id: 'ARCH-001',
          kind: 'functional',
          name: 'Login UI',
          responsibility: 'Renders login',
          row: 0,
          col: 0,
          rowSpan: 1,
          colSpan: 1,
          interfaces: [],
          elementInterfaces: [],
        },
      ],
      nextElementSeq: 2,
      nextInterfaceSeq: 1,
    },
  }
}

async function withGeneratedTestCase(passes = true) {
  const dir = await tempProjectDir()
  const project = baseProject()
  await scaffoldProjectSourceTree(project, dir)
  const srcRoot = sourceTreeRoot(dir)
  await mkdir(path.join(srcRoot, 'login-ui'), { recursive: true })
  await writeFile(path.join(srcRoot, 'login-ui', 'login.test.mjs'), `console.log('ok');\n`, 'utf-8')
  const { testCase } = createTestCase(project, {
    type: 'functional',
    title: 'Renders login form',
    requirementIds: ['REQ-001'],
    architectureElementId: 'ARCH-001',
  })
  testCase!.filePath = 'login-ui/login.test.mjs'
  testCase!.status = passes ? 'passing' : 'failing'
  testCase!.lastRunAt = new Date().toISOString()
  return { dir, project, testCase: testCase! }
}

test('reconcileTestCaseFiles: a still-present file is left completely untouched', async () => {
  const { dir, project, testCase } = await withGeneratedTestCase()
  try {
    const result = reconcileTestCaseFiles(project, dir)
    assert.equal(result.changed, false)
    assert.deepEqual(result.cleared, [])
    assert.deepEqual(result.orphaned, [])
    assert.equal(testCase.filePath, 'login-ui/login.test.mjs')
    assert.equal(testCase.status, 'passing')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('reconcileTestCaseFiles: a deleted file clears the pointer and resets the test case', async () => {
  const { dir, project, testCase } = await withGeneratedTestCase()
  try {
    await rm(path.join(sourceTreeRoot(dir), 'login-ui', 'login.test.mjs'), { force: true })

    const result = reconcileTestCaseFiles(project, dir)

    assert.equal(result.changed, true)
    assert.deepEqual(result.cleared, [
      { testCaseId: testCase.id, filePath: 'login-ui/login.test.mjs', reason: 'file-missing' },
    ])
    assert.equal(testCase.filePath, undefined)
    assert.equal(testCase.status, 'not-run')
    assert.equal(testCase.lastRunAt, undefined)
    assert.equal(testCase.deletedAt, undefined, 'a missing file resets, it does not soft-delete')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('reconcileTestCaseFiles: a filePath that exists but is NOT a test file is cleared as not-a-test-file (T1.3 — the Worm 2 TEST-003 bug)', async () => {
  const { dir, project, testCase } = await withGeneratedTestCase()
  try {
    // The diff-order heuristic recorded a support file, e.g. an index.html,
    // that really exists on disk — the old existsSync-only check never freed
    // it, so the test case was wedged forever: skipped by "generate
    // automations" (has a filePath) and never run (not a test file).
    const srcRoot = sourceTreeRoot(dir)
    await writeFile(path.join(srcRoot, 'login-ui', 'index.html'), '<!doctype html>', 'utf-8')
    testCase.filePath = 'login-ui/index.html'

    const result = reconcileTestCaseFiles(project, dir)

    assert.equal(result.changed, true)
    assert.deepEqual(result.cleared, [
      { testCaseId: testCase.id, filePath: 'login-ui/index.html', reason: 'not-a-test-file' },
    ])
    assert.equal(testCase.filePath, undefined)
    assert.equal(testCase.status, 'not-run')
    assert.equal(testCase.deletedAt, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('reconcileTestCaseFiles: a test case whose architecture element no longer exists is soft-deleted', async () => {
  const { dir, project, testCase } = await withGeneratedTestCase()
  try {
    // Element removed (as deleteArchitectureElement would), file still on disk.
    project.architecture!.elements = []

    const result = reconcileTestCaseFiles(project, dir)

    assert.equal(result.changed, true)
    assert.deepEqual(
      result.orphaned.map((o) => ({ id: o.testCaseId, reason: o.reason })),
      [{ id: testCase.id, reason: 'element-deleted' }],
    )
    assert.ok(testCase.deletedAt, 'orphaned test case is soft-deleted')
    assert.deepEqual(result.cleared, [], 'element-deleted takes priority over the file check')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('reconcileTestCaseFiles: an already-soft-deleted test case is skipped', async () => {
  const { dir, project, testCase } = await withGeneratedTestCase()
  try {
    testCase.deletedAt = new Date().toISOString()
    await rm(path.join(sourceTreeRoot(dir), 'login-ui', 'login.test.mjs'), { force: true })

    const result = reconcileTestCaseFiles(project, dir)

    assert.equal(result.changed, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('reconcileTestCaseFiles: a test case that never had a filePath is untouched', async () => {
  const dir = await tempProjectDir()
  try {
    const project = baseProject()
    await scaffoldProjectSourceTree(project, dir)
    const { testCase } = createTestCase(project, {
      type: 'functional',
      title: 'Not generated yet',
      requirementIds: ['REQ-001'],
      architectureElementId: 'ARCH-001',
    })
    const statusBefore = testCase!.status

    const result = reconcileTestCaseFiles(project, dir)

    assert.equal(result.changed, false)
    assert.equal(testCase!.status, statusBefore)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('reconcileTestCaseFiles: idempotent — a second call after a heal is a no-op', async () => {
  const { dir, project } = await withGeneratedTestCase()
  try {
    await rm(path.join(sourceTreeRoot(dir), 'login-ui', 'login.test.mjs'), { force: true })
    const first = reconcileTestCaseFiles(project, dir)
    assert.equal(first.changed, true)

    const second = reconcileTestCaseFiles(project, dir)
    assert.equal(second.changed, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
