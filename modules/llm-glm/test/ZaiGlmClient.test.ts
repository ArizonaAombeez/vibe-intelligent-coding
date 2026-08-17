import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { ZaiGlmClient, GlmApiError } from '../src/index.js'

const originalFetch = globalThis.fetch
const originalApiKey = process.env.GLM_API_KEY

interface MockCall {
  url: string
  init: RequestInit
}

type MockResponse = { ok: boolean; status: number; body: unknown; text?: string }

let calls: MockCall[] = []
let mockResponse: MockResponse
// When set, each successive fetch call pops the next entry instead of
// always returning mockResponse — used to simulate a transient failure
// followed by a success on retry.
let mockResponseQueue: MockResponse[] | undefined

function installMockFetch() {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const res = mockResponseQueue?.length ? mockResponseQueue.shift()! : mockResponse
    return {
      ok: res.ok,
      status: res.status,
      statusText: 'Mock Status',
      json: async () => res.body,
      text: async () => res.text ?? '',
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
  mockResponseQueue = undefined
  installMockFetch()
})

test('throws if GLM_API_KEY is not set and no apiKey option given', () => {
  const saved = process.env.GLM_API_KEY
  delete process.env.GLM_API_KEY
  assert.throws(() => new ZaiGlmClient(), /GLM_API_KEY is not set/)
  process.env.GLM_API_KEY = saved
})

test('defaults to the Coding Plan endpoint (safer default than pay-as-you-go)', async () => {
  mockResponse = { ok: true, status: 200, body: { choices: [{ message: { content: 'hello there' } }] } }
  const client = new ZaiGlmClient()

  const result = await client.chat([{ role: 'user', content: 'hi' }], { temperature: 0.5 })

  assert.equal(result.content, 'hello there')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.z.ai/api/coding/paas/v4/chat/completions')
  assert.equal(calls[0].init.method, 'POST')
  const headers = calls[0].init.headers as Record<string, string>
  assert.equal(headers['Content-Type'], 'application/json')
  assert.equal(headers['Authorization'], 'Bearer test-key-123')
  const body = JSON.parse(calls[0].init.body as string)
  assert.equal(body.model, 'glm-5.2')
  assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }])
  assert.equal(body.temperature, 0.5)
})

test('accessMethod "payg" uses the pay-as-you-go endpoint', async () => {
  mockResponse = { ok: true, status: 200, body: { choices: [{ message: { content: 'x' } }] } }
  const client = new ZaiGlmClient({ accessMethod: 'payg' })

  await client.chat([{ role: 'user', content: 'hi' }])

  assert.equal(calls[0].url, 'https://api.z.ai/api/paas/v4/chat/completions')
})

test('accessMethod "coding-plan" uses the Coding Plan endpoint', async () => {
  mockResponse = { ok: true, status: 200, body: { choices: [{ message: { content: 'x' } }] } }
  const client = new ZaiGlmClient({ accessMethod: 'coding-plan' })

  await client.chat([{ role: 'user', content: 'hi' }])

  assert.equal(calls[0].url, 'https://api.z.ai/api/coding/paas/v4/chat/completions')
})

test('explicit baseUrl always wins over accessMethod', async () => {
  mockResponse = { ok: true, status: 200, body: { choices: [{ message: { content: 'x' } }] } }
  const client = new ZaiGlmClient({ accessMethod: 'payg', baseUrl: 'https://example.test/custom' })

  await client.chat([{ role: 'user', content: 'hi' }])

  assert.equal(calls[0].url, 'https://example.test/custom/chat/completions')
})

test('uses a custom model when provided', async () => {
  mockResponse = { ok: true, status: 200, body: { choices: [{ message: { content: 'x' } }] } }
  const client = new ZaiGlmClient({ model: 'glm-4.7-flash' })

  await client.chat([{ role: 'user', content: 'hi' }])

  const body = JSON.parse(calls[0].init.body as string)
  assert.equal(body.model, 'glm-4.7-flash')
})

test('per-call model option overrides the client-configured model', async () => {
  mockResponse = { ok: true, status: 200, body: { choices: [{ message: { content: 'x' } }] } }
  const client = new ZaiGlmClient({ model: 'glm-5.2' })

  await client.chat([{ role: 'user', content: 'hi' }], { model: 'glm-4.5-air' })

  const body = JSON.parse(calls[0].init.body as string)
  assert.equal(body.model, 'glm-4.5-air')
})

test('sends thinking:{type:"disabled"} when thinking option is disabled', async () => {
  mockResponse = { ok: true, status: 200, body: { choices: [{ message: { content: 'x' } }] } }
  const client = new ZaiGlmClient()

  await client.chat([{ role: 'user', content: 'hi' }], { thinking: 'disabled' })

  const body = JSON.parse(calls[0].init.body as string)
  assert.deepEqual(body.thinking, { type: 'disabled' })
})

test('sends thinking:{type:"enabled"} when thinking option is enabled', async () => {
  mockResponse = { ok: true, status: 200, body: { choices: [{ message: { content: 'x' } }] } }
  const client = new ZaiGlmClient()

  await client.chat([{ role: 'user', content: 'hi' }], { thinking: 'enabled' })

  const body = JSON.parse(calls[0].init.body as string)
  assert.deepEqual(body.thinking, { type: 'enabled' })
})

test('omits thinking from the request body when not specified', async () => {
  mockResponse = { ok: true, status: 200, body: { choices: [{ message: { content: 'x' } }] } }
  const client = new ZaiGlmClient()

  await client.chat([{ role: 'user', content: 'hi' }])

  const body = JSON.parse(calls[0].init.body as string)
  assert.equal('thinking' in body, false)
})

test('throws GlmApiError on non-2xx response', async () => {
  mockResponse = { ok: false, status: 401, body: {}, text: 'unauthorized' }
  const client = new ZaiGlmClient()

  await assert.rejects(
    () => client.chat([{ role: 'user', content: 'hi' }]),
    (err: unknown) => {
      assert.ok(err instanceof GlmApiError)
      assert.equal(err.status, 401)
      assert.match(err.message, /401/)
      return true
    },
  )
})

test('does not retry a non-retryable status like 401', async () => {
  mockResponse = { ok: false, status: 401, body: {}, text: 'unauthorized' }
  const client = new ZaiGlmClient()

  await assert.rejects(() => client.chat([{ role: 'user', content: 'hi' }]), GlmApiError)
  assert.equal(calls.length, 1)
})

test('retries on 524 and succeeds if a later attempt is ok', async () => {
  mockResponseQueue = [
    { ok: false, status: 524, body: {}, text: 'timeout' },
    { ok: true, status: 200, body: { choices: [{ message: { content: 'recovered' } }] } },
  ]
  const client = new ZaiGlmClient()

  const result = await client.chat([{ role: 'user', content: 'hi' }])

  assert.equal(result.content, 'recovered')
  assert.equal(calls.length, 2)
})

test('retries 502/503 up to the retry limit then throws GlmApiError', async () => {
  mockResponse = { ok: false, status: 503, body: {}, text: 'unavailable' }
  const client = new ZaiGlmClient()

  await assert.rejects(
    () => client.chat([{ role: 'user', content: 'hi' }]),
    (err: unknown) => {
      assert.ok(err instanceof GlmApiError)
      assert.equal(err.status, 503)
      return true
    },
  )
  // 1 initial attempt + MAX_RETRIES retries
  assert.equal(calls.length, 3)
})

test('throws GlmApiError if response has no message content', async () => {
  mockResponse = { ok: true, status: 200, body: { choices: [] } }
  const client = new ZaiGlmClient()

  await assert.rejects(() => client.chat([{ role: 'user', content: 'hi' }]), GlmApiError)
})

test('parses usage from the response when present', async () => {
  mockResponse = {
    ok: true,
    status: 200,
    body: {
      choices: [{ message: { content: 'x' } }],
      usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 },
    },
  }
  const client = new ZaiGlmClient()

  const result = await client.chat([{ role: 'user', content: 'hi' }])

  assert.deepEqual(result.usage, { promptTokens: 12, completionTokens: 34, totalTokens: 46 })
})

test('usage is undefined when the response omits it', async () => {
  mockResponse = { ok: true, status: 200, body: { choices: [{ message: { content: 'x' } }] } }
  const client = new ZaiGlmClient()

  const result = await client.chat([{ role: 'user', content: 'hi' }])

  assert.equal(result.usage, undefined)
})
