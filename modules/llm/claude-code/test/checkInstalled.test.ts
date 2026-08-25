import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkClaudeCodeInstalled } from '../src/index.js'

test('reports not installed when the binary does not exist on PATH', async () => {
  const status = await checkClaudeCodeInstalled('vic-nonexistent-cli-binary-xyz')

  assert.equal(status.installed, false)
  assert.ok(status.error && status.error.length > 0)
  assert.equal(status.version, undefined)
})

test('reports installed with a parsed version when the binary exits 0', async () => {
  // node is guaranteed to exist in this test environment and --version
  // behaves the same way as `claude --version`: prints a version string to
  // stdout and exits 0. Stands in for the real CLI without depending on it
  // actually being installed on the machine running the test suite.
  const status = await checkClaudeCodeInstalled('node')

  assert.equal(status.installed, true)
  assert.ok(status.version && status.version.length > 0)
  assert.equal(status.error, undefined)
})

test('reports not installed when the binary exits non-zero', async () => {
  // Passing an unrecognized flag ahead of --version makes node itself exit
  // non-zero ("bad option"), exercising the exitCode !== 0 branch without
  // depending on any binary that isn't guaranteed to exist in CI.
  const status = await checkClaudeCodeInstalled('node --bogus-flag-xyz')

  assert.equal(status.installed, false)
  assert.ok(status.error && status.error.length > 0)
})
