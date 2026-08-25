import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { OpenCodeAgentClient } from '../src/index.js'

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-opencode.mjs')

async function tempCwd(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'vic-opencode-agentclient-test-'))
}

// Confirms the generated per-run opencode.json forces non-streamed tool
// calls for GLM (see OpenCodeAgentClient.ts's tool_stream comment): GLM-5.x
// has a documented bug where a *streamed* tool-call response can drop its
// delta chunks entirely, producing a clean CLI exit with nothing ever
// written. z.ai's own API defaults tool_stream to false already, but
// @ai-sdk/openai-compatible (what OpenCode uses) forces stream:true on the
// outer request regardless — opencode's documented provider-level `body`
// passthrough is what lets this client override tool_stream specifically,
// without a custom fetch/plugin. This test spawns a fake `opencode` binary
// that echoes the config file it was pointed at, so a regression here (the
// field silently dropped, misspelled, or nested wrong) fails loudly instead
// of only surfacing as an intermittent empty-output run days later.
test('OpenCodeAgentClient: generated config sets tool_stream:false on the vic-glm provider to avoid GLM-5.x dropped-tool-call-delta bug', async () => {
  const cwd = await tempCwd()
  try {
    const client = new OpenCodeAgentClient()
    const { rawLog } = await client.runAgentTask('irrelevant prompt', {
      cwd,
      model: 'glm-5.2',
      apiKey: 'test-key',
      baseUrl: 'https://api.z.ai/api/coding/paas/v4',
      binary: 'node',
      binaryArgs: [fixture],
    })

    const config = JSON.parse(rawLog)
    const providerOptions = config.provider['vic-glm'].options
    assert.equal(providerOptions.body.tool_stream, false)
    assert.equal(providerOptions.baseURL, 'https://api.z.ai/api/coding/paas/v4')
    assert.equal(providerOptions.apiKey, 'test-key')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

// Regression test for the specific bug this session found: the persona
// Settings UI lets a user disable GLM's "thinking" (extended reasoning) for
// the Dev persona, and resolvePersonaLlmOptions in the server correctly
// resolved that value — but nothing threaded it any further, so every real
// Coding run against GLM still ran with z.ai's default (thinking enabled)
// regardless of the setting. Confirms the value now actually reaches the
// generated opencode.json's request body in z.ai's expected shape
// ({ thinking: { type: 'disabled' } }), not just that the option is typed.
test('OpenCodeAgentClient: a supplied thinking option is forwarded to z.ai as body.thinking.type', async () => {
  const cwd = await tempCwd()
  try {
    const client = new OpenCodeAgentClient()
    const { rawLog } = await client.runAgentTask('irrelevant prompt', {
      cwd,
      model: 'glm-5.2',
      apiKey: 'test-key',
      baseUrl: 'https://api.z.ai/api/coding/paas/v4',
      thinking: 'disabled',
      binary: 'node',
      binaryArgs: [fixture],
    })

    const config = JSON.parse(rawLog)
    const body = config.provider['vic-glm'].options.body
    assert.deepEqual(body.thinking, { type: 'disabled' })
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('OpenCodeAgentClient: thinking is omitted from the request body when no thinking option is supplied', async () => {
  const cwd = await tempCwd()
  try {
    const client = new OpenCodeAgentClient()
    const { rawLog } = await client.runAgentTask('irrelevant prompt', {
      cwd,
      model: 'glm-5.2',
      apiKey: 'test-key',
      baseUrl: 'https://api.z.ai/api/coding/paas/v4',
      binary: 'node',
      binaryArgs: [fixture],
    })

    const config = JSON.parse(rawLog)
    const body = config.provider['vic-glm'].options.body
    assert.equal('thinking' in body, false)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
