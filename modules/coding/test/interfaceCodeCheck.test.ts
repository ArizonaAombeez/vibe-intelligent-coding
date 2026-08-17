import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Architecture } from 'vic-requirements-elicitation'
import { checkInterfaceCodeAlignment } from '../src/index.js'

async function tempProjectDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'vic-interface-code-check-test-'))
}

function architectureWithContract(operations: Array<{ name: string }>): Architecture {
  return {
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
        name: 'Auth Service',
        responsibility: 'Authenticates users',
        row: 0,
        col: 1,
        rowSpan: 1,
        colSpan: 1,
        interfaces: [],
      },
    ],
    nextElementSeq: 3,
    interfaceContracts: [
      {
        fromId: 'ARCH-001',
        toId: 'ARCH-002',
        status: 'defined',
        operations: operations.map((op) => ({
          name: op.name,
          description: '',
          request: '',
          response: '',
          errors: '',
        })),
      },
    ],
  }
}

test('checkInterfaceCodeAlignment: reports an operation as unimplemented when no code exists yet', async () => {
  const projectDir = await tempProjectDir()
  try {
    const architecture = architectureWithContract([{ name: 'Login' }])
    const result = await checkInterfaceCodeAlignment(projectDir, architecture)
    assert.equal(result.aligned, false)
    assert.equal(result.unimplementedOperations.length, 1)
    assert.equal(result.unimplementedOperations[0].operationName, 'Login')
    assert.equal(result.undocumentedIdentifiers.length, 0)
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})

test('checkInterfaceCodeAlignment: matches a contract operation to a declared function in the shared-interface folder', async () => {
  const projectDir = await tempProjectDir()
  try {
    const architecture = architectureWithContract([{ name: 'Login' }])
    const sharedDir = path.join(projectDir, 'src', '_shared-interfaces', 'ARCH-001__ARCH-002')
    await mkdir(sharedDir, { recursive: true })
    await writeFile(path.join(sharedDir, 'auth.ts'), 'export function login(user: string) { return user }\n', 'utf-8')

    const result = await checkInterfaceCodeAlignment(projectDir, architecture)
    assert.equal(result.unimplementedOperations.length, 0)
    assert.equal(result.undocumentedIdentifiers.length, 0)
    assert.equal(result.aligned, true)
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})

test('checkInterfaceCodeAlignment: flags a declared function with no matching contract operation', async () => {
  const projectDir = await tempProjectDir()
  try {
    const architecture = architectureWithContract([{ name: 'Login' }])
    const sharedDir = path.join(projectDir, 'src', '_shared-interfaces', 'ARCH-001__ARCH-002')
    await mkdir(sharedDir, { recursive: true })
    await writeFile(
      path.join(sharedDir, 'auth.ts'),
      'export function login(user: string) { return user }\nexport function resetPassword(user: string) { return user }\n',
      'utf-8',
    )

    const result = await checkInterfaceCodeAlignment(projectDir, architecture)
    assert.equal(result.unimplementedOperations.length, 0)
    assert.equal(result.undocumentedIdentifiers.length, 1)
    assert.equal(result.undocumentedIdentifiers[0].operationName, 'resetPassword')
    assert.equal(result.aligned, false)
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})

test('checkInterfaceCodeAlignment: skips a pair with no defined contract', async () => {
  const projectDir = await tempProjectDir()
  try {
    const architecture = architectureWithContract([])
    architecture.interfaceContracts = []
    const result = await checkInterfaceCodeAlignment(projectDir, architecture)
    assert.equal(result.unimplementedOperations.length, 0)
    assert.equal(result.undocumentedIdentifiers.length, 0)
    assert.equal(result.aligned, true)
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})
