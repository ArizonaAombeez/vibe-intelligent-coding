import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Project } from 'vic-requirements-elicitation'
import { scaffoldProjectSourceTree, sourceTreeRoot } from '../src/index.js'

async function tempProjectDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'vic-scaffold-test-'))
}

function projectWithArchitecture(): Project {
  return {
    schemaVersion: 1,
    id: 'proj-1',
    name: 'Test',
    projectMode: 'new',
    requirements: [],
    architecture: {
      layers: ['Core'],
      elements: [
        {
          id: 'ARCH-001',
          kind: 'functional',
          name: 'Login UI',
          responsibility: 'Renders login',
          row: 0,
          col: 0,
          rowSpan: 1,
          colSpan: 1,
          interfaces: ['ARCH-002'],
        },
        {
          id: 'ARCH-002',
          kind: 'service',
          name: 'Auth Service!',
          responsibility: 'Authenticates users',
          row: 0,
          col: 1,
          rowSpan: 1,
          colSpan: 1,
          interfaces: [],
        },
      ],
      nextElementSeq: 3,
    },
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

test('scaffoldProjectSourceTree creates one slugged subfolder per element plus shared-interface pairs', async () => {
  const dir = await tempProjectDir()
  try {
    const project = projectWithArchitecture()
    const result = await scaffoldProjectSourceTree(project, dir)

    assert.deepEqual(
      result.createdFolders.sort(),
      ['login-ui', 'auth-service', path.join('_shared-interfaces', 'ARCH-001__ARCH-002')].sort(),
    )
    assert.ok(await exists(path.join(sourceTreeRoot(dir), 'login-ui')))
    assert.ok(await exists(path.join(sourceTreeRoot(dir), 'auth-service')))
    assert.ok(await exists(path.join(sourceTreeRoot(dir), '_shared-interfaces', 'ARCH-001__ARCH-002')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('scaffoldProjectSourceTree writes a marker file mapping folder back to element id', async () => {
  const dir = await tempProjectDir()
  try {
    const project = projectWithArchitecture()
    await scaffoldProjectSourceTree(project, dir)

    const marker = JSON.parse(
      await readFile(path.join(sourceTreeRoot(dir), 'login-ui', '.vic-element.json'), 'utf-8'),
    )
    assert.equal(marker.architectureElementId, 'ARCH-001')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('scaffoldProjectSourceTree is idempotent — re-running does not duplicate or wipe folders', async () => {
  const dir = await tempProjectDir()
  try {
    const project = projectWithArchitecture()
    const first = await scaffoldProjectSourceTree(project, dir)
    const second = await scaffoldProjectSourceTree(project, dir)

    assert.deepEqual(first.createdFolders.sort(), second.createdFolders.sort())
    assert.ok(await exists(path.join(sourceTreeRoot(dir), 'login-ui')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('scaffoldProjectSourceTree preserves a per-element testCommand set on a prior marker across re-scaffold', async () => {
  const dir = await tempProjectDir()
  try {
    const project = projectWithArchitecture()
    await scaffoldProjectSourceTree(project, dir)
    const markerPath = path.join(sourceTreeRoot(dir), 'login-ui', '.vic-element.json')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(
      markerPath,
      JSON.stringify({ architectureElementId: 'ARCH-001', name: 'Login UI', testCommand: 'pytest', testArgs: [] }),
      'utf-8',
    )

    await scaffoldProjectSourceTree(project, dir)

    const marker = JSON.parse(await readFile(markerPath, 'utf-8'))
    assert.equal(marker.testCommand, 'pytest')
    assert.deepEqual(marker.testArgs, [])
    assert.equal(marker.architectureElementId, 'ARCH-001', 're-scaffold must still refresh the identity fields it owns')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('scaffoldProjectSourceTree throws when the project has no architecture yet', async () => {
  const dir = await tempProjectDir()
  try {
    const project: Project = {
      schemaVersion: 1,
      id: 'proj-1',
      name: 'Test',
      projectMode: 'new',
      requirements: [],
    }
    await assert.rejects(() => scaffoldProjectSourceTree(project, dir), /architecture/i)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
