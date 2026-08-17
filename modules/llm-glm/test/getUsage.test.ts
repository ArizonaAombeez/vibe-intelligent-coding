import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { getUsage, GlmUsageError } from '../src/index.js'

const originalFetch = globalThis.fetch
const originalApiKey = process.env.GLM_API_KEY

interface MockCall {
  url: string
  init: RequestInit
}

let calls: MockCall[] = []
let mockResponse: { ok: boolean; status: number; body: unknown; text?: string }

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

before(() => {
  process.env.GLM_API_KEY = 'test-key-123'
})

after(() => {
  globalThis.fetch = originalFetch
  if (originalApiKey === undefined) {
    delete process.env.GLM_API_KEY
  } else {
    process.env.GLM_API_KEY = originalApiKey
  }
})

beforeEach(() => {
  calls = []
  installMockFetch()
})

test('throws GlmUsageError if no apiKey is configured', async () => {
  const saved = process.env.GLM_API_KEY
  delete process.env.GLM_API_KEY
  await assert.rejects(() => getUsage({}), GlmUsageError)
  process.env.GLM_API_KEY = saved
})

test('calls the quota/limit endpoint with the raw key (no Bearer prefix)', async () => {
  mockResponse = { ok: true, status: 200, body: { data: { limits: [] } } }

  await getUsage({ apiKey: 'my-key' })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.z.ai/api/monitor/usage/quota/limit')
  const headers = calls[0].init.headers as Record<string, string>
  assert.equal(headers['Authorization'], 'my-key')
})

test('falls back to GLM_API_KEY env var when values.apiKey is absent', async () => {
  mockResponse = { ok: true, status: 200, body: { data: { limits: [] } } }

  await getUsage({})

  const headers = calls[0].init.headers as Record<string, string>
  assert.equal(headers['Authorization'], 'test-key-123')
})

test('picks out the 5-hour token window by (unit=3, number=5)', async () => {
  mockResponse = {
    ok: true,
    status: 200,
    body: {
      data: {
        limits: [
          { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 42, nextResetTime: 1_700_000_000_000 },
          { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 7, nextResetTime: 1_700_100_000_000 },
        ],
      },
    },
  }

  const usage = await getUsage({ apiKey: 'k' })

  assert.deepEqual(usage.currentWindow, {
    percentUsed: 42,
    resetsAt: new Date(1_700_000_000_000).toISOString(),
  })
})

test('picks out the weekly token window by (unit=6, number=1)', async () => {
  mockResponse = {
    ok: true,
    status: 200,
    body: {
      data: {
        limits: [
          { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 42, nextResetTime: 1_700_000_000_000 },
          { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 7, nextResetTime: 1_700_100_000_000 },
        ],
      },
    },
  }

  const usage = await getUsage({ apiKey: 'k' })

  assert.deepEqual(usage.weekly, {
    percentUsed: 7,
    resetsAt: new Date(1_700_100_000_000).toISOString(),
  })
})

test('ignores unrelated limit entries (e.g. monthly MCP usage)', async () => {
  mockResponse = {
    ok: true,
    status: 200,
    body: {
      data: {
        limits: [{ type: 'TOKENS_LIMIT', unit: 7, number: 1, percentage: 99, nextResetTime: 1_700_000_000_000 }],
      },
    },
  }

  const usage = await getUsage({ apiKey: 'k' })

  assert.equal(usage.currentWindow, undefined)
  assert.equal(usage.weekly, undefined)
})

test('windows without a numeric percentage are omitted', async () => {
  mockResponse = {
    ok: true,
    status: 200,
    body: { data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5 }] } },
  }

  const usage = await getUsage({ apiKey: 'k' })

  assert.equal(usage.currentWindow, undefined)
})

test('missing limits array yields both windows undefined', async () => {
  mockResponse = { ok: true, status: 200, body: {} }

  const usage = await getUsage({ apiKey: 'k' })

  assert.equal(usage.currentWindow, undefined)
  assert.equal(usage.weekly, undefined)
})

test('throws GlmUsageError on non-2xx response', async () => {
  mockResponse = { ok: false, status: 401, body: {}, text: 'unauthorized' }

  await assert.rejects(
    () => getUsage({ apiKey: 'k' }),
    (err: unknown) => {
      assert.ok(err instanceof GlmUsageError)
      assert.match(err.message, /401/)
      return true
    },
  )
})
