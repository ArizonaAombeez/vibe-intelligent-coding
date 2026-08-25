import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import { ClaudeCodeAgentClient, ClaudeCodeAgentError } from '../src/index.js'

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude-agent.mjs')

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'vic-agent-test-'))
}

test('runAgentTask parses a successful result', async () => {
  process.env.FAKE_CLAUDE_MODE = 'ok'
  const cwd = await tempDir()
  try {
    const client = new ClaudeCodeAgentClient()
    const result = await client.runAgentTask('do the thing', { cwd, binary: 'node', binaryArgs: [fixture] })

    assert.equal(result.exitCode, 0)
    assert.equal(result.sessionId, 'agent-session-1')
    assert.match(result.rawLog, /done/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('runAgentTask always passes --permission-mode, defaulting to acceptEdits', async () => {
  process.env.FAKE_CLAUDE_MODE = 'echo-args'
  const cwd = await tempDir()
  try {
    const client = new ClaudeCodeAgentClient()
    const result = await client.runAgentTask('prompt', { cwd, binary: 'node', binaryArgs: [fixture] })

    const parsed = JSON.parse(result.rawLog)
    const argv = JSON.parse(parsed.result) as string[]
    assert.ok(argv.includes('--permission-mode'))
    assert.ok(argv.includes('acceptEdits'))
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('runAgentTask passes a custom permissionMode/model/effort through', async () => {
  process.env.FAKE_CLAUDE_MODE = 'echo-args'
  const cwd = await tempDir()
  try {
    const client = new ClaudeCodeAgentClient()
    const result = await client.runAgentTask('prompt', {
      cwd,
      binary: 'node',
      binaryArgs: [fixture],
      permissionMode: 'bypassPermissions',
      model: 'sonnet',
      effort: 'high',
    })

    const parsed = JSON.parse(result.rawLog)
    const argv = JSON.parse(parsed.result) as string[]
    assert.ok(argv.includes('bypassPermissions'))
    assert.ok(argv.includes('--model'))
    assert.ok(argv.includes('sonnet'))
    assert.ok(argv.includes('--effort'))
    assert.ok(argv.includes('high'))
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('runAgentTask throws ClaudeCodeAgentError on non-zero exit', async () => {
  process.env.FAKE_CLAUDE_MODE = 'nonzero-exit'
  const cwd = await tempDir()
  try {
    const client = new ClaudeCodeAgentClient()
    await assert.rejects(
      () => client.runAgentTask('prompt', { cwd, binary: 'node', binaryArgs: [fixture] }),
      (err: unknown) => {
        assert.ok(err instanceof ClaudeCodeAgentError)
        assert.equal((err as ClaudeCodeAgentError).exitCode, 1)
        return true
      },
    )
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('runAgentTask throws ClaudeCodeAgentError when the CLI reports is_error', async () => {
  process.env.FAKE_CLAUDE_MODE = 'error-result'
  const cwd = await tempDir()
  try {
    const client = new ClaudeCodeAgentClient()
    await assert.rejects(
      () => client.runAgentTask('prompt', { cwd, binary: 'node', binaryArgs: [fixture] }),
      ClaudeCodeAgentError,
    )
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('runAgentTask spawns with the given cwd (fixture writes relative to process.cwd())', async () => {
  process.env.FAKE_CLAUDE_MODE = 'write-in-scope'
  process.env.FAKE_CLAUDE_WRITE_PATH = 'element-a/file.txt'
  const cwd = await tempDir()
  try {
    const client = new ClaudeCodeAgentClient()
    await client.runAgentTask('prompt', { cwd, binary: 'node', binaryArgs: [fixture] })

    const { readFile } = await import('node:fs/promises')
    const content = await readFile(path.join(cwd, 'element-a', 'file.txt'), 'utf8')
    assert.equal(content, 'in scope content')
  } finally {
    await rm(cwd, { recursive: true, force: true })
    delete process.env.FAKE_CLAUDE_WRITE_PATH
  }
})
