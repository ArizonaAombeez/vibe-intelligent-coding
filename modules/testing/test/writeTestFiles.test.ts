import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ClaudeCodeAgentClient } from 'vic-llm-claude-code'
import type { Project, TestCase } from 'vic-requirements-elicitation'
import { generateTestFileForTestCase } from '../src/index.js'
import { sourceTreeRoot } from 'vic-coding'

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'llm',
  'claude-code',
  'test',
  'fixtures',
  'fake-claude-agent.mjs',
)

async function tempProjectDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'vic-writetest-test-'))
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
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
        { id: 'ARCH-001', kind: 'functional', name: 'Login UI', responsibility: 'Renders login', row: 0, col: 0, rowSpan: 1, colSpan: 1, interfaces: [], elementInterfaces: [] },
        { id: 'ARCH-002', kind: 'service', name: 'Auth Service', responsibility: 'Authenticates users', row: 0, col: 1, rowSpan: 1, colSpan: 1, interfaces: [], elementInterfaces: [] },
      ],
      nextElementSeq: 3,
      nextInterfaceSeq: 1,
    },
  }
}

function functionalTestCase(): TestCase {
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

test('generateTestFileForTestCase: an in-scope write is committed and filePath is set', async () => {
  process.env.FAKE_CLAUDE_MODE = 'write-in-scope'
  process.env.FAKE_CLAUDE_WRITE_PATH = 'login-ui/login.test.ts'
  const dir = await tempProjectDir()
  try {
    const project = baseProject()
    const testCase = functionalTestCase()
    const client = new ClaudeCodeAgentClient()

    const result = await generateTestFileForTestCase(project, dir, testCase, client, {
      binary: 'node',
      binaryArgs: [fixture],
    })

    assert.equal(result.status, 'success')
    assert.equal(result.testCase.filePath, 'login-ui/login.test.ts')
    assert.ok(await exists(path.join(sourceTreeRoot(dir), 'login-ui', 'login.test.ts')))
  } finally {
    await rm(dir, { recursive: true, force: true })
    delete process.env.FAKE_CLAUDE_WRITE_PATH
  }
})

test('generateTestFileForTestCase: an out-of-scope write is reverted from disk, filePath left unset, status rejected-scope', async () => {
  process.env.FAKE_CLAUDE_MODE = 'write-out-of-scope'
  process.env.FAKE_CLAUDE_WRITE_PATH = 'auth-service/escaped.test.ts'
  const dir = await tempProjectDir()
  try {
    const project = baseProject()
    const testCase = functionalTestCase()
    const client = new ClaudeCodeAgentClient()

    const result = await generateTestFileForTestCase(project, dir, testCase, client, {
      binary: 'node',
      binaryArgs: [fixture],
    })

    assert.equal(result.status, 'rejected-scope')
    assert.equal(result.testCase.filePath, undefined)
    // Real filesystem assertion, not just the returned status.
    assert.equal(await exists(path.join(sourceTreeRoot(dir), 'auth-service', 'escaped.test.ts')), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
    delete process.env.FAKE_CLAUDE_WRITE_PATH
  }
})

test('generateTestFileForTestCase: an interface test case is scoped to the shared-interface subfolder', async () => {
  process.env.FAKE_CLAUDE_MODE = 'write-in-scope'
  process.env.FAKE_CLAUDE_WRITE_PATH = path.join('_shared-interfaces', 'ARCH-001__ARCH-002', 'contract.test.ts')
  const dir = await tempProjectDir()
  try {
    const project = baseProject()
    project.architecture!.elements[0].interfaces = ['ARCH-002']
    const testCase: TestCase = {
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
    const client = new ClaudeCodeAgentClient()

    const result = await generateTestFileForTestCase(project, dir, testCase, client, {
      binary: 'node',
      binaryArgs: [fixture],
    })

    assert.equal(result.status, 'success')
  } finally {
    await rm(dir, { recursive: true, force: true })
    delete process.env.FAKE_CLAUDE_WRITE_PATH
  }
})

test('generateTestFileForTestCase: a CLI-level failure returns status cli-error', async () => {
  process.env.FAKE_CLAUDE_MODE = 'nonzero-exit'
  const dir = await tempProjectDir()
  try {
    const project = baseProject()
    const testCase = functionalTestCase()
    const client = new ClaudeCodeAgentClient()

    const result = await generateTestFileForTestCase(project, dir, testCase, client, {
      binary: 'node',
      binaryArgs: [fixture],
    })

    assert.equal(result.status, 'cli-error')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('generateTestFileForTestCase: filePath is the test file, not git\'s alphabetically-first changed path (T1.2)', async () => {
  process.env.FAKE_CLAUDE_MODE = 'write-in-scope-multi'
  // index.html sorts before nav.test.mjs — the old changedInScope[0] would
  // have recorded the .html here (this is the exact Worm 2 TEST-003 bug).
  process.env.FAKE_CLAUDE_SUPPORT_PATH = 'login-ui/index.html'
  process.env.FAKE_CLAUDE_WRITE_PATH = 'login-ui/nav.test.mjs'
  const dir = await tempProjectDir()
  try {
    const project = baseProject()
    const testCase = functionalTestCase()
    const client = new ClaudeCodeAgentClient()

    const result = await generateTestFileForTestCase(project, dir, testCase, client, {
      binary: 'node',
      binaryArgs: [fixture],
    })

    assert.equal(result.status, 'success')
    assert.equal(result.testCase.filePath, 'login-ui/nav.test.mjs')
  } finally {
    await rm(dir, { recursive: true, force: true })
    delete process.env.FAKE_CLAUDE_SUPPORT_PATH
    delete process.env.FAKE_CLAUDE_WRITE_PATH
  }
})

test('generateTestFileForTestCase scaffolds the source tree before invoking the agent', async () => {
  process.env.FAKE_CLAUDE_MODE = 'ok'
  const dir = await tempProjectDir()
  try {
    const project = baseProject()
    const testCase = functionalTestCase()
    const client = new ClaudeCodeAgentClient()

    await generateTestFileForTestCase(project, dir, testCase, client, { binary: 'node', binaryArgs: [fixture] })

    assert.ok(await exists(path.join(sourceTreeRoot(dir), 'login-ui', '.vic-element.json')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

