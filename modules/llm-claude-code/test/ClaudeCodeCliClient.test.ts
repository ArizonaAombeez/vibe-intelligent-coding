import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { ClaudeCodeCliClient, ClaudeCodeCliError } from '../src/index.js'

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.mjs')

function clientWithMode(mode: string, options: { model?: string } = {}) {
  process.env.FAKE_CLAUDE_MODE = mode
  return new ClaudeCodeCliClient({ binary: 'node', binaryArgs: [fixture], model: options.model })
}

test('parses a successful CLI result into ChatResult', async () => {
  const client = clientWithMode('ok')

  const result = await client.chat([{ role: 'user', content: 'hi there' }])

  assert.equal(result.content, 'echo: hi there')
  assert.equal(result.sessionId, 'fake-session-123')
  assert.deepEqual(result.usage, {
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    cacheReadTokens: 2,
    cacheCreationTokens: 0,
  })
})

test('folds multi-message history into a single prompt with role markers', async () => {
  process.env.FAKE_CLAUDE_MODE = 'echo-args'
  const client = new ClaudeCodeCliClient({ binary: 'node', binaryArgs: [fixture] })

  const result = await client.chat([
    { role: 'system', content: 'be terse' },
    { role: 'user', content: 'hello' },
  ])

  const args = JSON.parse(result.content) as string[]
  const prompt = args[args.length - 1]
  assert.match(prompt, /\[system\]\nbe terse/)
  assert.match(prompt, /hello/)
})

test('passes --model when a model is configured', async () => {
  process.env.FAKE_CLAUDE_MODE = 'echo-args'
  const client = new ClaudeCodeCliClient({ binary: 'node', binaryArgs: [fixture], model: 'sonnet' })

  const result = await client.chat([{ role: 'user', content: 'hi' }])

  const args = JSON.parse(result.content) as string[]
  assert.ok(args.includes('--model'))
  assert.ok(args.includes('sonnet'))
})

test('per-call model option overrides the client-configured model', async () => {
  process.env.FAKE_CLAUDE_MODE = 'echo-args'
  const client = new ClaudeCodeCliClient({ binary: 'node', binaryArgs: [fixture], model: 'sonnet' })

  const result = await client.chat([{ role: 'user', content: 'hi' }], { model: 'opus' })

  const args = JSON.parse(result.content) as string[]
  assert.ok(args.includes('opus'))
  assert.ok(!args.includes('sonnet'))
})

test('passes --effort when an effort level is configured', async () => {
  process.env.FAKE_CLAUDE_MODE = 'echo-args'
  const client = new ClaudeCodeCliClient({ binary: 'node', binaryArgs: [fixture], effort: 'high' })

  const result = await client.chat([{ role: 'user', content: 'hi' }])

  const args = JSON.parse(result.content) as string[]
  assert.ok(args.includes('--effort'))
  assert.ok(args.includes('high'))
})

test('per-call effort option overrides the client-configured effort', async () => {
  process.env.FAKE_CLAUDE_MODE = 'echo-args'
  const client = new ClaudeCodeCliClient({ binary: 'node', binaryArgs: [fixture], effort: 'high' })

  const result = await client.chat([{ role: 'user', content: 'hi' }], { effort: 'low' })

  const args = JSON.parse(result.content) as string[]
  assert.ok(args.includes('low'))
  assert.ok(!args.includes('high'))
})

test('handles a response with no usage block', async () => {
  const client = clientWithMode('no-usage')

  const result = await client.chat([{ role: 'user', content: 'hi' }])

  assert.equal(result.content, 'no usage here')
  assert.equal(result.usage, undefined)
})

test('throws ClaudeCodeCliError when the CLI reports is_error', async () => {
  const client = clientWithMode('error-result')

  await assert.rejects(
    () => client.chat([{ role: 'user', content: 'hi' }]),
    (err: unknown) => {
      assert.ok(err instanceof ClaudeCodeCliError)
      return true
    },
  )
})

test('throws ClaudeCodeCliError on unparseable stdout', async () => {
  const client = clientWithMode('bad-json')

  await assert.rejects(() => client.chat([{ role: 'user', content: 'hi' }]), ClaudeCodeCliError)
})

test('throws ClaudeCodeCliError on non-zero exit', async () => {
  const client = clientWithMode('nonzero-exit')

  await assert.rejects(
    () => client.chat([{ role: 'user', content: 'hi' }]),
    (err: unknown) => {
      assert.ok(err instanceof ClaudeCodeCliError)
      assert.equal((err as ClaudeCodeCliError).exitCode, 1)
      assert.match((err as ClaudeCodeCliError).stderr ?? '', /simulated CLI failure/)
      return true
    },
  )
})

test('surfaces a clear error when the binary itself cannot be launched', async () => {
  const client = new ClaudeCodeCliClient({ binary: 'vic-nonexistent-cli-binary-xyz' })

  await assert.rejects(
    () => client.chat([{ role: 'user', content: 'hi' }]),
    (err: unknown) => {
      assert.ok(err instanceof ClaudeCodeCliError)
      assert.match((err as Error).message, /Is Claude Code installed/)
      return true
    },
  )
})
