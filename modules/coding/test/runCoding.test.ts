import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ClaudeCodeAgentClient } from 'vic-llm-claude-code'
import type { Project } from 'vic-requirements-elicitation'
import { runCodingForElement, sourceTreeRoot } from '../src/index.js'

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'llm-claude-code',
  'test',
  'fixtures',
  'fake-claude-agent.mjs',
)

async function tempProjectDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'vic-runcoding-test-'))
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

// Element/requirement-based fixture (element-based Coding rewrite) —
// replaces the old Story-based baseProject/storyFor helpers. REQ-001 is
// allocated to ARCH-001 ('Login UI') via architectureElements, no Story
// involved at all.
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
        status: 'allocated',
        createdAt: new Date().toISOString(),
        provenance: 'human',
        architectureElements: ['ARCH-001'],
      },
    ],
    architecture: {
      layers: ['Core'],
      elements: [
        { id: 'ARCH-001', kind: 'functional', name: 'Login UI', responsibility: 'Renders login', row: 0, col: 0, rowSpan: 1, colSpan: 1, interfaces: ['ARCH-002'] },
        { id: 'ARCH-002', kind: 'service', name: 'Auth Service', responsibility: 'Authenticates users', row: 0, col: 1, rowSpan: 1, colSpan: 1, interfaces: [] },
      ],
      nextElementSeq: 3,
    },
  }
}

test('runCodingForElement: an in-scope write is committed, diff captured, status success', async () => {
  process.env.FAKE_CLAUDE_MODE = 'write-in-scope'
  process.env.FAKE_CLAUDE_WRITE_PATH = 'login-ui/generated.txt'
  const dir = await tempProjectDir()
  try {
    const project = baseProject()
    const client = new ClaudeCodeAgentClient()

    const run = await runCodingForElement(project, dir, 'ARCH-001', client, { binary: 'node', binaryArgs: [fixture] })

    assert.equal(run.status, 'success')
    assert.equal(run.allowedSubfolder, 'login-ui')
    assert.equal(run.architectureElementId, 'ARCH-001')
    assert.match(run.diff, /generated\.txt/)
    assert.ok(await exists(path.join(sourceTreeRoot(dir), 'login-ui', 'generated.txt')))
  } finally {
    await rm(dir, { recursive: true, force: true })
    delete process.env.FAKE_CLAUDE_WRITE_PATH
  }
})

test('runCodingForElement: an out-of-scope write is reverted from disk, status rejected-scope', async () => {
  process.env.FAKE_CLAUDE_MODE = 'write-out-of-scope'
  process.env.FAKE_CLAUDE_WRITE_PATH = 'auth-service/escaped.txt'
  const dir = await tempProjectDir()
  try {
    const project = baseProject()
    const client = new ClaudeCodeAgentClient()

    const run = await runCodingForElement(project, dir, 'ARCH-001', client, { binary: 'node', binaryArgs: [fixture] })

    assert.equal(run.status, 'rejected-scope')
    assert.ok(run.rejectedFiles && run.rejectedFiles.length > 0)
    // Real filesystem assertion, not just the returned status: the escaped
    // file must actually be gone after the call returns.
    assert.equal(await exists(path.join(sourceTreeRoot(dir), 'auth-service', 'escaped.txt')), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
    delete process.env.FAKE_CLAUDE_WRITE_PATH
  }
})

test('runCodingForElement: an out-of-scope write does not clobber a legitimately in-scope file from the same run', async () => {
  process.env.FAKE_CLAUDE_MODE = 'write-out-of-scope'
  process.env.FAKE_CLAUDE_WRITE_PATH = 'auth-service/escaped.txt'
  const dir = await tempProjectDir()
  try {
    const project = baseProject()
    const client = new ClaudeCodeAgentClient()

    // Pre-seed an in-scope file that already existed before this run, to
    // confirm the revert only targets the newly-created out-of-scope path.
    const { mkdir, writeFile } = await import('node:fs/promises')
    const { scaffoldProjectSourceTree, gitInitIfNeeded, gitCommitAll } = await import('../src/index.js')
    await scaffoldProjectSourceTree(project, dir)
    await mkdir(path.join(sourceTreeRoot(dir), 'login-ui'), { recursive: true })
    await writeFile(path.join(sourceTreeRoot(dir), 'login-ui', 'existing.txt'), 'pre-existing', 'utf8')
    await gitInitIfNeeded(sourceTreeRoot(dir))
    await gitCommitAll(sourceTreeRoot(dir), 'seed')

    await runCodingForElement(project, dir, 'ARCH-001', client, { binary: 'node', binaryArgs: [fixture] })

    const content = await (await import('node:fs/promises')).readFile(
      path.join(sourceTreeRoot(dir), 'login-ui', 'existing.txt'),
      'utf8',
    )
    assert.equal(content, 'pre-existing')
  } finally {
    await rm(dir, { recursive: true, force: true })
    delete process.env.FAKE_CLAUDE_WRITE_PATH
  }
})

test('runCodingForElement: an unknown architecture element id is rejected before any subprocess is spawned', async () => {
  process.env.FAKE_CLAUDE_MODE = 'ok'
  const dir = await tempProjectDir()
  try {
    const project = baseProject()
    // Give the (nonexistent) element an eligible requirement so eligibility
    // isn't what trips the rejection — this is testing the "element not
    // found" path specifically.
    project.requirements.push({
      id: 'REQ-999',
      text: 'Orphaned requirement',
      type: null,
      status: 'allocated',
      createdAt: new Date().toISOString(),
      provenance: 'human',
      architectureElements: ['ARCH-999'],
    })
    const client = new ClaudeCodeAgentClient()
    let spawnCount = 0
    const originalRunAgentTask = client.runAgentTask.bind(client)
    client.runAgentTask = async (...args) => {
      spawnCount++
      return originalRunAgentTask(...args)
    }

    const run = await runCodingForElement(project, dir, 'ARCH-999', client, { binary: 'node', binaryArgs: [fixture] })

    assert.equal(run.status, 'rejected-not-eligible')
    assert.equal(spawnCount, 0, 'the CLI must never be spawned for an unknown element')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// No shared-scope conflict is possible anymore (Area B/D, resolved): a
// requirement allocated to two elements simply appears in both elements'
// own requirement lists — each Coding run still targets exactly one
// element's own folder. This replaces the old "2 elements -> shared
// -interface subfolder" story-based test.
test('runCodingForElement: a requirement allocated to two elements still scopes a run to exactly one element\'s own folder', async () => {
  process.env.FAKE_CLAUDE_MODE = 'write-in-scope'
  process.env.FAKE_CLAUDE_WRITE_PATH = 'auth-service/generated.ts'
  const dir = await tempProjectDir()
  try {
    const project = baseProject()
    project.requirements[0].architectureElements = ['ARCH-001', 'ARCH-002']
    const client = new ClaudeCodeAgentClient()

    const run = await runCodingForElement(project, dir, 'ARCH-002', client, { binary: 'node', binaryArgs: [fixture] })

    assert.equal(run.status, 'success')
    assert.equal(run.allowedSubfolder, 'auth-service')
    assert.equal(run.architectureElementId, 'ARCH-002')
  } finally {
    await rm(dir, { recursive: true, force: true })
    delete process.env.FAKE_CLAUDE_WRITE_PATH
  }
})

test('runCodingForElement: an element with no allocated requirement at "allocated" status is rejected before any subprocess is spawned', async () => {
  process.env.FAKE_CLAUDE_MODE = 'ok'
  const dir = await tempProjectDir()
  try {
    const project = baseProject()
    project.requirements[0].status = 'complete'
    const client = new ClaudeCodeAgentClient()
    let spawnCount = 0
    const originalRunAgentTask = client.runAgentTask.bind(client)
    client.runAgentTask = async (...args) => {
      spawnCount++
      return originalRunAgentTask(...args)
    }

    const run = await runCodingForElement(project, dir, 'ARCH-001', client, { binary: 'node', binaryArgs: [fixture] })

    assert.equal(run.status, 'rejected-not-eligible')
    assert.equal(spawnCount, 0, 'the CLI must never be spawned for a not-eligible element')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runCodingForElement: an element with at least one allocated requirement among several proceeds normally', async () => {
  process.env.FAKE_CLAUDE_MODE = 'write-in-scope'
  process.env.FAKE_CLAUDE_WRITE_PATH = 'login-ui/generated.txt'
  const dir = await tempProjectDir()
  try {
    const project = baseProject()
    project.requirements.push({
      id: 'REQ-002',
      text: 'The system shall show a validation error',
      type: null,
      status: 'complete',
      createdAt: new Date().toISOString(),
      provenance: 'human',
      architectureElements: ['ARCH-001'],
    })
    const client = new ClaudeCodeAgentClient()

    const run = await runCodingForElement(project, dir, 'ARCH-001', client, { binary: 'node', binaryArgs: [fixture] })

    assert.equal(run.status, 'success')
  } finally {
    await rm(dir, { recursive: true, force: true })
    delete process.env.FAKE_CLAUDE_WRITE_PATH
  }
})

test('runCodingForElement: "recode from scratch" wipe followed by a no-op agent run is rejected, not committed as a deletion', async () => {
  const dir = await tempProjectDir()
  try {
    const project = baseProject()
    const client = new ClaudeCodeAgentClient()

    // First run: agent actually writes the element's file, gets committed —
    // this is the "existing implementation" a later recode-from-scratch
    // will wipe.
    process.env.FAKE_CLAUDE_MODE = 'write-in-scope'
    process.env.FAKE_CLAUDE_WRITE_PATH = 'login-ui/index.html'
    const firstRun = await runCodingForElement(project, dir, 'ARCH-001', client, { binary: 'node', binaryArgs: [fixture] })
    assert.equal(firstRun.status, 'success')
    const filePath = path.join(sourceTreeRoot(dir), 'login-ui', 'index.html')
    assert.ok(await exists(filePath))

    // Simulate wipeScopedSubfolder: a raw filesystem delete (not a git
    // commit) of the element's folder, as "recode from scratch" performs
    // before re-running the agent.
    await rm(path.join(sourceTreeRoot(dir), 'login-ui'), { recursive: true, force: true })
    await mkdir(path.join(sourceTreeRoot(dir), 'login-ui'), { recursive: true })

    // Second run: the agent CLI exits 0 with no error but writes nothing
    // (mode 'ok') — the silent no-op this guard exists to catch.
    process.env.FAKE_CLAUDE_MODE = 'ok'
    delete process.env.FAKE_CLAUDE_WRITE_PATH
    const secondRun = await runCodingForElement(project, dir, 'ARCH-001', client, { binary: 'node', binaryArgs: [fixture] })

    assert.equal(secondRun.status, 'rejected-empty-output')
    assert.equal(secondRun.diff, '')
    // The wipe must be undone — the previous implementation restored, not
    // left deleted and committed.
    assert.ok(await exists(filePath), 'expected the pre-wipe file to be restored after the no-op agent run')
  } finally {
    await rm(dir, { recursive: true, force: true })
    delete process.env.FAKE_CLAUDE_MODE
    delete process.env.FAKE_CLAUDE_WRITE_PATH
  }
})

test('runCodingForElement: a CLI-level failure returns status cli-error without touching the scope gate', async () => {
  process.env.FAKE_CLAUDE_MODE = 'nonzero-exit'
  const dir = await tempProjectDir()
  try {
    const project = baseProject()
    const client = new ClaudeCodeAgentClient()

    const run = await runCodingForElement(project, dir, 'ARCH-001', client, { binary: 'node', binaryArgs: [fixture] })

    assert.equal(run.status, 'cli-error')
    assert.equal(run.diff, '')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
