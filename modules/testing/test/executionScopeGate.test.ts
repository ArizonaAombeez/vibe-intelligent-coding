import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resolveExecutionScope } from '../src/index.js'

async function tempSrcRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vic-execscope-test-'))
  return dir
}

test('resolveExecutionScope resolves a single-element scope to a cwd strictly inside srcRoot', async () => {
  const srcRoot = await tempSrcRoot()
  try {
    await mkdir(path.join(srcRoot, 'login-ui'), { recursive: true })
    const elementSubfolderById = new Map([['ARCH-001', 'login-ui']])

    const result = resolveExecutionScope({ architectureElementId: 'ARCH-001' }, elementSubfolderById, srcRoot)

    assert.ok(!('rejected' in result))
    if (!('rejected' in result)) {
      assert.equal(result.cwd, path.resolve(path.join(srcRoot, 'login-ui')))
      assert.ok(result.cwd.startsWith(path.resolve(srcRoot)))
    }
  } finally {
    await rm(srcRoot, { recursive: true, force: true })
  }
})

test('resolveExecutionScope rejects a scope that resolves to no element (multi-element/unresolvable)', async () => {
  const srcRoot = await tempSrcRoot()
  try {
    const result = resolveExecutionScope({ architectureElementId: null }, new Map(), srcRoot)
    assert.deepEqual(result, { rejected: 'multi-element' })
  } finally {
    await rm(srcRoot, { recursive: true, force: true })
  }
})

test('resolveExecutionScope rejects a scope whose subfolder has never been scaffolded on disk', async () => {
  const srcRoot = await tempSrcRoot()
  try {
    const elementSubfolderById = new Map([['ARCH-001', 'login-ui']])
    const result = resolveExecutionScope({ architectureElementId: 'ARCH-001' }, elementSubfolderById, srcRoot)
    assert.deepEqual(result, { rejected: 'scope-not-found' })
  } finally {
    await rm(srcRoot, { recursive: true, force: true })
  }
})

test('resolveExecutionScope resolves an interface-pair scope to the shared-interfaces subfolder', async () => {
  const srcRoot = await tempSrcRoot()
  try {
    await mkdir(path.join(srcRoot, '_shared-interfaces', 'ARCH-001__ARCH-002'), { recursive: true })

    const result = resolveExecutionScope(
      { architectureElementId: null, interfaceElementIds: ['ARCH-001', 'ARCH-002'] },
      new Map(),
      srcRoot,
    )

    assert.ok(!('rejected' in result))
    if (!('rejected' in result)) {
      assert.equal(result.allowedRelativePrefix, path.join('_shared-interfaces', 'ARCH-001__ARCH-002'))
    }
  } finally {
    await rm(srcRoot, { recursive: true, force: true })
  }
})
