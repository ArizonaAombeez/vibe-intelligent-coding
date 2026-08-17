import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  proposeCodeGapRequirements,
  proposeCodeGapRequirementsPerFile,
  importDocumentsAsRequirements,
  createRequirementFromForm as createRequirementFromFormReal,
} from '../src/index.js'
import type {
  CodeStripOptions,
  LlmCallOptions,
  LlmChatResult,
  LlmClient,
  LlmMessage,
  Project,
  CreateRequirementFields,
  Requirement,
} from '../src/index.js'

function emptyProject(): Project {
  return {
    schemaVersion: 1,
    id: 'proj-1',
    name: 'Test Project',
    projectMode: 'import',
    requirements: [],
  }
}

// Requirement ids come from a global counter in real use (see
// globalSeqStore.ts); tests fake it with a per-project counter so each
// fresh emptyProject() still gets REQ-001, REQ-002, ... in order.
const seqByProject = new WeakMap<Project, number>()
function createRequirementFromForm(project: Project, fields: CreateRequirementFields): Requirement {
  const seq = seqByProject.get(project) ?? 1
  seqByProject.set(project, seq + 1)
  return createRequirementFromFormReal(project, fields, seq)
}

// Stand-in for globalSeqStore.reserveRequirementSeqBlock in tests.
function fakeReserveSeqBlock() {
  let seq = 1
  return async (count: number) => {
    const start = seq
    seq += count
    return start
  }
}

class FakeLlmClient implements LlmClient {
  public receivedMessages: LlmMessage[][] = []
  private callIndex = 0

  constructor(private readonly replies: string[]) {}

  async chat(messages: LlmMessage[], _options?: LlmCallOptions): Promise<LlmChatResult> {
    this.receivedMessages.push(messages)
    const content = this.replies[this.callIndex] ?? this.replies[this.replies.length - 1]
    this.callIndex++
    return { content }
  }
}

test('proposeCodeGapRequirements returns proposals without committing them', async () => {
  const project = emptyProject()
  const llmClient = new FakeLlmClient([
    'REQUIREMENT: The system shall log every login attempt.\nREQUIREMENT: The system shall reject empty passwords.',
  ])

  const result = await proposeCodeGapRequirements(
    project,
    llmClient,
    [{ path: 'src/auth.ts', content: 'function login() { /* ... */ }' }],
  )

  assert.deepEqual(result.proposedRequirements, [
    'The system shall log every login attempt.',
    'The system shall reject empty passwords.',
  ])
  assert.equal(project.requirements.length, 0)
})

test('proposeCodeGapRequirements makes no LLM call when there are no code files', async () => {
  const project = emptyProject()
  const llmClient = new FakeLlmClient(['REQUIREMENT: should not be called'])

  const result = await proposeCodeGapRequirements(project, llmClient, [])

  assert.deepEqual(result.proposedRequirements, [])
  assert.equal(llmClient.receivedMessages.length, 0)
})

test('proposeCodeGapRequirements includes every code file in the prompt', async () => {
  const project = emptyProject()
  const llmClient = new FakeLlmClient(['NONE'])

  await proposeCodeGapRequirements(project, llmClient, [
    { path: 'a.ts', content: 'const a = 1' },
    { path: 'b.ts', content: 'const b = 2' },
  ])

  const userMessage = llmClient.receivedMessages[0].find((m) => m.role === 'user')!.content
  assert.match(userMessage, /a\.ts/)
  assert.match(userMessage, /const a = 1/)
  assert.match(userMessage, /b\.ts/)
  assert.match(userMessage, /const b = 2/)
})

test('proposeCodeGapRequirements includes the existing confirmed requirement set in the prompt, proving it is gap-aware not blind', async () => {
  const project = emptyProject()
  createRequirementFromForm(project, {
    text: 'The system shall log every request.',
    provenance: 'imported-document',
  })
  const llmClient = new FakeLlmClient(['NONE'])

  await proposeCodeGapRequirements(project, llmClient, [
    { path: 'src/logger.ts', content: 'function logRequest() { /* ... */ }' },
  ])

  const userMessage = llmClient.receivedMessages[0].find((m) => m.role === 'user')!.content
  assert.match(userMessage, /REQ-001/)
  assert.match(userMessage, /The system shall log every request\./)
})

test('proposeCodeGapRequirements tells the LLM nothing has been elicited yet when the project has no requirements', async () => {
  const project = emptyProject()
  const llmClient = new FakeLlmClient(['NONE'])

  await proposeCodeGapRequirements(project, llmClient, [{ path: 'a.ts', content: 'const a = 1' }])

  const userMessage = llmClient.receivedMessages[0].find((m) => m.role === 'user')!.content
  assert.match(userMessage, /No requirements have been elicited yet\./)
})

test('proposeCodeGapRequirements applies stripOptions to file content before it reaches the LLM', async () => {
  const project = emptyProject()
  const llmClient = new FakeLlmClient(['NONE'])
  const stripOptions: CodeStripOptions = { stripBlankLines: true, stripComments: true, stripBodies: false }

  await proposeCodeGapRequirements(
    project,
    llmClient,
    [{ path: 'a.ts', content: 'const a = 1\n\n// a comment\nconst b = 2' }],
    undefined,
    stripOptions,
  )

  const userMessage = llmClient.receivedMessages[0].find((m) => m.role === 'user')!.content
  assert.doesNotMatch(userMessage, /a comment/)
  assert.match(userMessage, /const a = 1/)
})

test('proposeCodeGapRequirementsPerFile applies stripOptions to each file before it reaches the LLM', async () => {
  const project = emptyProject()
  const llmClient = new FakeLlmClient(['NONE'])
  const stripOptions: CodeStripOptions = { stripBlankLines: false, stripComments: true, stripBodies: false }

  await proposeCodeGapRequirementsPerFile(
    project,
    llmClient,
    [{ path: 'a.ts', content: 'const a = 1 // trailing comment' }],
    undefined,
    undefined,
    stripOptions,
  )

  const userMessage = llmClient.receivedMessages[0].find((m) => m.role === 'user')!.content
  assert.doesNotMatch(userMessage, /trailing comment/)
  assert.match(userMessage, /const a = 1/)
})

test('importDocumentsAsRequirements commits tagged-format documents directly with imported-document provenance', async () => {
  const project = emptyProject()
  const llmClient = new FakeLlmClient(['should not be called for a tagged document'])

  const taggedDoc = 'REQ_001\nThe system shall do a thing.\n##END_OF_REQ'
  const result = await importDocumentsAsRequirements(
    project,
    llmClient,
    [{ path: 'spec.txt', content: taggedDoc }],
    fakeReserveSeqBlock(),
  )

  assert.deepEqual(result.committedRequirementTexts, ['The system shall do a thing.'])
  assert.deepEqual(result.proposedRequirements, [])
  assert.equal(project.requirements.length, 1)
  assert.equal(project.requirements[0].provenance, 'imported-document')
  assert.equal(llmClient.receivedMessages.length, 0)
})

test('importDocumentsAsRequirements proposes (does not commit) requirements from free-prose documents', async () => {
  const project = emptyProject()
  const llmClient = new FakeLlmClient([
    'REQUIREMENT: The system shall support CSV export.',
  ])

  const result = await importDocumentsAsRequirements(
    project,
    llmClient,
    [{ path: 'README.md', content: 'This tool exports reports as CSV files for the finance team.' }],
    fakeReserveSeqBlock(),
  )

  assert.deepEqual(result.proposedRequirements, ['The system shall support CSV export.'])
  assert.deepEqual(result.committedRequirementTexts, [])
  assert.equal(project.requirements.length, 0)
})

test('importDocumentsAsRequirements skips empty free-prose documents without an LLM call', async () => {
  const project = emptyProject()
  const llmClient = new FakeLlmClient(['should not be called'])

  const result = await importDocumentsAsRequirements(
    project,
    llmClient,
    [{ path: 'empty.md', content: '   \n  ' }],
    fakeReserveSeqBlock(),
  )

  assert.deepEqual(result.proposedRequirements, [])
  assert.equal(llmClient.receivedMessages.length, 0)
})

test('proposeCodeGapRequirementsPerFile makes one LLM call per file, not one call for all files', async () => {
  const project = emptyProject()
  const llmClient = new FakeLlmClient([
    'REQUIREMENT: The system shall log every login attempt.',
    'REQUIREMENT: The system shall support CSV export.',
  ])

  const result = await proposeCodeGapRequirementsPerFile(project, llmClient, [
    { path: 'src/auth.ts', content: 'function login() { /* ... */ }' },
    { path: 'src/export.ts', content: 'function exportCsv() { /* ... */ }' },
  ])

  assert.equal(llmClient.receivedMessages.length, 2)
  assert.deepEqual(result.proposedRequirements, [
    'The system shall log every login attempt.',
    'The system shall support CSV export.',
  ])
})

test('proposeCodeGapRequirementsPerFile sends only one file at a time in each call', async () => {
  const project = emptyProject()
  const llmClient = new FakeLlmClient(['NONE'])

  await proposeCodeGapRequirementsPerFile(project, llmClient, [
    { path: 'a.ts', content: 'const a = 1' },
    { path: 'b.ts', content: 'const b = 2' },
  ])

  const firstCallMessage = llmClient.receivedMessages[0].find((m) => m.role === 'user')!.content
  assert.match(firstCallMessage, /a\.ts/)
  assert.doesNotMatch(firstCallMessage, /b\.ts/)

  const secondCallMessage = llmClient.receivedMessages[1].find((m) => m.role === 'user')!.content
  assert.match(secondCallMessage, /b\.ts/)
  assert.doesNotMatch(secondCallMessage, /a\.ts/)
})

test('proposeCodeGapRequirementsPerFile tells later files about proposals from earlier files, so cross-file duplicates are not proposed twice', async () => {
  const project = emptyProject()
  const llmClient = new FakeLlmClient([
    'REQUIREMENT: The system shall validate email addresses.',
    'NONE',
  ])

  await proposeCodeGapRequirementsPerFile(project, llmClient, [
    { path: 'a.ts', content: 'function validateEmail() {}' },
    { path: 'b.ts', content: 'function validateEmail() {}' },
  ])

  const secondCallMessage = llmClient.receivedMessages[1].find((m) => m.role === 'user')!.content
  assert.match(secondCallMessage, /proposed earlier this scan.*validate email addresses/i)
})

test('proposeCodeGapRequirementsPerFile calls onFileScanned once per file with progress', async () => {
  const project = emptyProject()
  const llmClient = new FakeLlmClient(['NONE'])
  const progress: Array<{ path: string; index: number; total: number }> = []

  await proposeCodeGapRequirementsPerFile(
    project,
    llmClient,
    [
      { path: 'a.ts', content: 'const a = 1' },
      { path: 'b.ts', content: 'const b = 2' },
    ],
    undefined,
    (path, index, total) => progress.push({ path, index, total }),
  )

  assert.deepEqual(progress, [
    { path: 'a.ts', index: 1, total: 2 },
    { path: 'b.ts', index: 2, total: 2 },
  ])
})

test('proposeCodeGapRequirementsPerFile makes no LLM call when there are no code files', async () => {
  const project = emptyProject()
  const llmClient = new FakeLlmClient(['should not be called'])

  const result = await proposeCodeGapRequirementsPerFile(project, llmClient, [])

  assert.deepEqual(result.proposedRequirements, [])
  assert.equal(llmClient.receivedMessages.length, 0)
})

test('accepting a reverse-elicited proposal stamps reverse-elicited-code provenance', () => {
  const project = emptyProject()
  const requirement = createRequirementFromForm(project, {
    text: 'The system shall log every login attempt.',
    provenance: 'reverse-elicited-code',
  })

  assert.equal(requirement.provenance, 'reverse-elicited-code')
})
