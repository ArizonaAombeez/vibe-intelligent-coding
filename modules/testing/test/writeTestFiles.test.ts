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

test('generateTestFileForTestCase: the first-ever generation call establishes project.testCommand from the agent\'s declared RUN: line', async () => {
  process.env.FAKE_CLAUDE_MODE = 'write-in-scope-declare-run-command'
  process.env.FAKE_CLAUDE_WRITE_PATH = 'login-ui/login.test.ts'
  process.env.FAKE_CLAUDE_RUN_LINE = 'RUN: node test.mjs ./index.html'
  const dir = await tempProjectDir()
  try {
    const project = baseProject()
    assert.equal(project.testCommand, undefined)
    const testCase = functionalTestCase()
    const client = new ClaudeCodeAgentClient()

    const result = await generateTestFileForTestCase(project, dir, testCase, client, {
      binary: 'node',
      binaryArgs: [fixture],
    })

    assert.equal(result.status, 'success')
    assert.deepEqual(project.testCommand, { command: 'node', args: ['test.mjs', './index.html'] })
  } finally {
    await rm(dir, { recursive: true, force: true })
    delete process.env.FAKE_CLAUDE_WRITE_PATH
    delete process.env.FAKE_CLAUDE_RUN_LINE
  }
})

test('generateTestFileForTestCase: a declared RUN: line matching the existing project default does not create a per-element override', async () => {
  process.env.FAKE_CLAUDE_MODE = 'write-in-scope-declare-run-command'
  process.env.FAKE_CLAUDE_WRITE_PATH = 'login-ui/login.test.ts'
  process.env.FAKE_CLAUDE_RUN_LINE = 'RUN: npx vitest run'
  const dir = await tempProjectDir()
  try {
    const project = baseProject()
    project.testCommand = { command: 'npx', args: ['vitest', 'run'] }
    const testCase = functionalTestCase()
    const client = new ClaudeCodeAgentClient()

    await generateTestFileForTestCase(project, dir, testCase, client, { binary: 'node', binaryArgs: [fixture] })

    // Still the project default, untouched — and no marker-file override
    // was written for this element (readElementTestCommand would otherwise
    // pick it up ahead of the project default).
    assert.deepEqual(project.testCommand, { command: 'npx', args: ['vitest', 'run'] })
    const { readElementTestCommand } = await import('../src/index.js')
    const resolved = await readElementTestCommand(sourceTreeRoot(dir), 'login-ui', project.testCommand)
    assert.deepEqual(resolved, { command: 'npx', args: ['vitest', 'run'] })
  } finally {
    await rm(dir, { recursive: true, force: true })
    delete process.env.FAKE_CLAUDE_WRITE_PATH
    delete process.env.FAKE_CLAUDE_RUN_LINE
  }
})

test('generateTestFileForTestCase: a declared RUN: line that deviates from the project default is stored as a per-element override', async () => {
  process.env.FAKE_CLAUDE_MODE = 'write-in-scope-declare-run-command'
  process.env.FAKE_CLAUDE_WRITE_PATH = 'login-ui/login.test.ts'
  process.env.FAKE_CLAUDE_RUN_LINE = 'RUN: python -m pytest'
  const dir = await tempProjectDir()
  try {
    const project = baseProject()
    project.testCommand = { command: 'npx', args: ['vitest', 'run'] }
    const testCase = functionalTestCase()
    const client = new ClaudeCodeAgentClient()

    await generateTestFileForTestCase(project, dir, testCase, client, { binary: 'node', binaryArgs: [fixture] })

    // Project-wide default is untouched by this element's deviation...
    assert.deepEqual(project.testCommand, { command: 'npx', args: ['vitest', 'run'] })
    // ...but this element now resolves to its own override ahead of it.
    const { readElementTestCommand } = await import('../src/index.js')
    const resolved = await readElementTestCommand(sourceTreeRoot(dir), 'login-ui', project.testCommand)
    assert.deepEqual(resolved, { command: 'python', args: ['-m', 'pytest'] })
  } finally {
    await rm(dir, { recursive: true, force: true })
    delete process.env.FAKE_CLAUDE_WRITE_PATH
    delete process.env.FAKE_CLAUDE_RUN_LINE
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

