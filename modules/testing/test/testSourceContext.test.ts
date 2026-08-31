import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Project, TestCase } from 'vic-requirements-elicitation'
import { sourceTreeRoot } from 'vic-coding'
import { gatherTestSourceContext } from '../src/testSourceContext.js'
import { buildTestGenerationPrompt } from '../src/testGenerationPersona.js'

function project(): Project {
  return {
    schemaVersion: 1,
    id: 'p1',
    name: 'T',
    projectMode: 'new',
    requirements: [
      {
        id: 'REQ-1',
        text: 'The worm shall change direction on arrow key',
        type: null,
        status: 'coded',
        createdAt: new Date().toISOString(),
        provenance: 'human',
        architectureElements: ['ARCH-1'],
      },
    ],
    architecture: {
      layers: ['Core'],
      elements: [
        { id: 'ARCH-1', kind: 'functional', name: 'User Interface', responsibility: 'input', row: 0, col: 0, rowSpan: 1, colSpan: 1, interfaces: [], elementInterfaces: [] },
      ],
      nextElementSeq: 2,
      nextInterfaceSeq: 1,
    },
  }
}

function functionalTest(): TestCase {
  return {
    id: 'TEST-1',
    type: 'functional',
    title: 'Arrow key changes direction',
    requirementIds: ['REQ-1'],
    architectureElementId: 'ARCH-1',
    status: 'not-run',
    createdAt: new Date().toISOString(),
  }
}

test('gatherTestSourceContext resolves the element entry file, its exports, and an example test — with no LLM call', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vic-srcctx-'))
  try {
    const srcRoot = sourceTreeRoot(dir)
    // Coding-agent's observed nested layout: user-interface/user-interface/
    const elDir = path.join(srcRoot, 'user-interface', 'user-interface')
    await mkdir(elDir, { recursive: true })
    await writeFile(
      path.join(elDir, 'index.js'),
      "export { InputHandler } from './input-handler.js'\nexport const DEFAULT_DIRECTION = 'right'\n",
    )
    await writeFile(path.join(elDir, 'input-handler.js'), 'export class InputHandler {}\n')
    // An existing sibling test in scope.
    await writeFile(
      path.join(srcRoot, 'user-interface', 'touch-input-direction.test.mjs'),
      "import assert from 'node:assert'\nassert.ok(true)\n",
    )

    const ctx = await gatherTestSourceContext(project(), functionalTest(), srcRoot, 'user-interface')

    assert.equal(ctx.targets.length, 1)
    const t = ctx.targets[0]
    // Import path is relative to the test file's dir (the element folder).
    assert.equal(t.importPath, './user-interface/index.js')
    assert.deepEqual(t.exportNames.sort(), ['DEFAULT_DIRECTION', 'InputHandler'])
    assert.match(t.content, /InputHandler/)
    assert.ok(ctx.exampleTest, 'should find the sibling .test.mjs')
    assert.equal(ctx.exampleTest?.name, 'touch-input-direction.test.mjs')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('buildTestGenerationPrompt with source context inlines the code + forbids exploration', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vic-srcctx-'))
  try {
    const srcRoot = sourceTreeRoot(dir)
    const elDir = path.join(srcRoot, 'user-interface')
    await mkdir(elDir, { recursive: true })
    await writeFile(path.join(elDir, 'index.js'), 'export function move() {}\n')

    const ctx = await gatherTestSourceContext(project(), functionalTest(), srcRoot, 'user-interface')
    const prompt = buildTestGenerationPrompt(project(), functionalTest(), 'user-interface', ctx)

    assert.match(prompt, /Do NOT use glob, grep, or find/)
    assert.match(prompt, /at most ONE fix attempt/)
    assert.match(prompt, /CODE UNDER TEST/)
    assert.match(prompt, /export function move/)
    assert.match(prompt, /import from "\.\/index\.js"/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('buildTestGenerationPrompt without context keeps the old "read the file yourself" wording', () => {
  const prompt = buildTestGenerationPrompt(project(), functionalTest(), 'user-interface')
  assert.match(prompt, /Read only the specific source file/)
  assert.doesNotMatch(prompt, /Do NOT use glob, grep, or find/)
})
