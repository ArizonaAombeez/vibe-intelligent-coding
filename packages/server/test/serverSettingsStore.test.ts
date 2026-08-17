import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { ServerSettingsStore } from '../src/serverSettingsStore.js'

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vic-server-settings-test-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('getProjectsRootOverride returns undefined when nothing has been saved yet', async () => {
  await withTempDir(async (dir) => {
    const store = new ServerSettingsStore(dir)
    assert.equal(await store.getProjectsRootOverride(), undefined)
  })
})

test('setProjectsRootOverride then getProjectsRootOverride round-trips', async () => {
  await withTempDir(async (dir) => {
    const store = new ServerSettingsStore(dir)
    const target = path.join(dir, 'shared-projects')
    await store.setProjectsRootOverride(target)
    assert.equal(await store.getProjectsRootOverride(), target)

    const raw = JSON.parse(await readFile(path.join(dir, 'server-settings.json'), 'utf-8'))
    assert.deepEqual(raw, { projectsRootOverride: target })
  })
})

test('setProjectsRootOverride(undefined) clears a previously saved override', async () => {
  await withTempDir(async (dir) => {
    const store = new ServerSettingsStore(dir)
    await store.setProjectsRootOverride(path.join(dir, 'shared-projects'))
    await store.setProjectsRootOverride(undefined)
    assert.equal(await store.getProjectsRootOverride(), undefined)

    const raw = JSON.parse(await readFile(path.join(dir, 'server-settings.json'), 'utf-8'))
    assert.deepEqual(raw, {})
  })
})

test('creates the directory on first write if it does not exist yet', async () => {
  await withTempDir(async (dir) => {
    const nested = path.join(dir, 'nested', 'settings-dir')
    const store = new ServerSettingsStore(nested)
    await store.setProjectsRootOverride('/some/path')
    assert.equal(await store.getProjectsRootOverride(), '/some/path')
  })
})
