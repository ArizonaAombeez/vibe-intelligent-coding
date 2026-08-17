import { test, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getUsage, ClaudeCodeUsageError, __setCredentialsPathForTests } from '../src/index.js'

const originalFetch = globalThis.fetch

interface MockCall {
  url: string
  init: RequestInit
}

let calls: MockCall[] = []
let mockResponse: { ok: boolean; status: number; body: unknown; text?: string }
let tmpDir: string

function installMockFetch() {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return {
      ok: mockResponse.ok,
      status: mockResponse.status,
      statusText: 'Mock Status',
      json: async () => mockResponse.body,
      text: async () => mockResponse.text ?? '',
    } as Response
  }) as typeof fetch
}

async function writeCredentials(contents: unknown): Promise<string> {
  const credentialsPath = path.join(tmpDir, '.credentials.json')
  await writeFile(credentialsPath, typeof contents === 'string' ? contents : JSON.stringify(contents))
  return credentialsPath
}

before(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'vic-claude-code-usage-test-'))
})

after(async () => {
  globalThis.fetch = originalFetch
  __setCredentialsPathForTests(undefined)
  await rm(tmpDir, { recursive: true, force: true })
})

beforeEach(() => {
  calls = []
  installMockFetch()
})

afterEach(() => {
  __setCredentialsPathForTests(undefined)
})

test('throws ClaudeCodeUsageError when the credentials file does not exist', async () => {
  __setCredentialsPathForTests(path.join(tmpDir, 'does-not-exist.json'))

  await assert.rejects(() => getUsage(), (err: unknown) => {
    assert.ok(err instanceof ClaudeCodeUsageError)
    assert.match(err.message, /Could not read Claude Code credentials/)
    return true
  })
})

test('throws ClaudeCodeUsageError when the credentials file is not valid JSON', async () => {
  __setCredentialsPathForTests(await writeCredentials('not json'))

  await assert.rejects(() => getUsage(), /not valid JSON/)
})

test('throws ClaudeCodeUsageError when the credentials file has no access token', async () => {
  __setCredentialsPathForTests(await writeCredentials({ claudeAiOauth: {} }))

  await assert.rejects(() => getUsage(), /no access token/)
})

test('sends the access token as a Bearer header with the oauth beta header', async () => {
  __setCredentialsPathForTests(await writeCredentials({ claudeAiOauth: { accessToken: 'tok_abc123' } }))
  mockResponse = { ok: true, status: 200, body: {} }

  await getUsage()

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.anthropic.com/api/oauth/usage')
  const headers = calls[0].init.headers as Record<string, string>
  assert.equal(headers['Authorization'], 'Bearer tok_abc123')
  assert.equal(headers['anthropic-beta'], 'oauth-2025-04-20')
})

test('maps five_hour.utilization/resets_at to currentWindow', async () => {
  __setCredentialsPathForTests(await writeCredentials({ claudeAiOauth: { accessToken: 'tok' } }))
  mockResponse = {
    ok: true,
    status: 200,
    body: { five_hour: { utilization: 63, resets_at: '2026-08-10T15:00:00Z' } },
  }

  const usage = await getUsage()

  assert.deepEqual(usage.currentWindow, { percentUsed: 63, resetsAt: '2026-08-10T15:00:00Z' })
})

test('maps seven_day.utilization/resets_at to weekly', async () => {
  __setCredentialsPathForTests(await writeCredentials({ claudeAiOauth: { accessToken: 'tok' } }))
  mockResponse = {
    ok: true,
    status: 200,
    body: { seven_day: { utilization: 11, resets_at: '2026-08-14T00:00:00Z' } },
  }

  const usage = await getUsage()

  assert.deepEqual(usage.weekly, { percentUsed: 11, resetsAt: '2026-08-14T00:00:00Z' })
})

test('both windows undefined when the response omits them (Pro/Max fields absent)', async () => {
  __setCredentialsPathForTests(await writeCredentials({ claudeAiOauth: { accessToken: 'tok' } }))
  mockResponse = { ok: true, status: 200, body: {} }

  const usage = await getUsage()

  assert.equal(usage.currentWindow, undefined)
  assert.equal(usage.weekly, undefined)
})

test('throws ClaudeCodeUsageError on non-2xx response', async () => {
  __setCredentialsPathForTests(await writeCredentials({ claudeAiOauth: { accessToken: 'tok' } }))
  mockResponse = { ok: false, status: 401, body: {}, text: 'unauthorized' }

  await assert.rejects(
    () => getUsage(),
    (err: unknown) => {
      assert.ok(err instanceof ClaudeCodeUsageError)
      assert.match(err.message, /401/)
      return true
    },
  )
})
