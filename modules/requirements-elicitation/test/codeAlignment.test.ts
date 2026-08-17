import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  runCodeAlignmentAnalysis,
  setArchitectureType,
  createArchitectureElement,
} from '../src/index.js'
import type { LlmCallOptions, LlmChatResult, LlmClient, LlmMessage, Project } from '../src/index.js'

function emptyProject(): Project {
  return {
    schemaVersion: 1,
    id: 'proj-1',
    name: 'Test Project',
    projectMode: 'import',
    requirements: [],
  }
}

class FakeLlmClient implements LlmClient {
  public receivedMessages: LlmMessage[][] = []
  constructor(private readonly reply: string) {}
  async chat(messages: LlmMessage[], _options?: LlmCallOptions): Promise<LlmChatResult> {
    this.receivedMessages.push(messages)
    return { content: this.reply }
  }
}

function projectWithArchitectureAndCode(files: Array<{ path: string; content: string }>): Project {
  const project = emptyProject()
  setArchitectureType(project, 'web-app')
  createArchitectureElement(project, {
    kind: 'functional',
    name: 'Login UI',
    responsibility: 'Renders the login form',
    row: 0,
    col: 0,
  })
  project.importedCode = { files, importedAt: new Date().toISOString() }
  return project
}

test('runCodeAlignmentAnalysis maps files to architecture elements from the LLM reply', async () => {
  const project = projectWithArchitectureAndCode([{ path: 'src/login.ts', content: 'render login' }])
  const fake = new FakeLlmClient('MAP: src/login.ts | ARCH-001 | aligned | Matches the login UI responsibility')

  const result = await runCodeAlignmentAnalysis(project, fake)

  assert.equal(result.mappings.length, 1)
  assert.deepEqual(result.mappings[0], {
    filePath: 'src/login.ts',
    architectureElementId: 'ARCH-001',
    status: 'aligned',
    rationale: 'Matches the login UI responsibility',
  })
  assert.deepEqual(project.codeAlignment?.mappings, result.mappings)
})

test('runCodeAlignmentAnalysis records NONE as an unmapped flag, not a dropped file (REQ-060)', async () => {
  const project = projectWithArchitectureAndCode([{ path: 'src/old-cron.ts', content: 'legacy cron job' }])
  const fake = new FakeLlmClient('MAP: src/old-cron.ts | NONE |  | No corresponding element in the new design')

  const result = await runCodeAlignmentAnalysis(project, fake)

  assert.equal(result.mappings[0].architectureElementId, null)
  assert.equal(result.mappings[0].status, null)
})

test('runCodeAlignmentAnalysis flags a file the LLM reply never mentioned, rather than dropping it (REQ-060)', async () => {
  const project = projectWithArchitectureAndCode([
    { path: 'src/login.ts', content: 'render login' },
    { path: 'src/forgotten.ts', content: 'something' },
  ])
  const fake = new FakeLlmClient('MAP: src/login.ts | ARCH-001 | aligned | Matches')

  const result = await runCodeAlignmentAnalysis(project, fake)

  assert.equal(result.mappings.length, 2)
  const forgotten = result.mappings.find((m) => m.filePath === 'src/forgotten.ts')
  assert.equal(forgotten?.architectureElementId, null)
  assert.ok(forgotten?.rationale)
})

test('runCodeAlignmentAnalysis throws when no architecture exists yet', async () => {
  const project = emptyProject()
  project.importedCode = { files: [{ path: 'a.ts', content: 'x' }], importedAt: new Date().toISOString() }
  const fake = new FakeLlmClient('NONE')
  await assert.rejects(() => runCodeAlignmentAnalysis(project, fake), /architecture/i)
})

test('runCodeAlignmentAnalysis throws when no imported code exists yet', async () => {
  const project = emptyProject()
  setArchitectureType(project, 'web-app')
  const fake = new FakeLlmClient('NONE')
  await assert.rejects(() => runCodeAlignmentAnalysis(project, fake), /imported code/i)
})
