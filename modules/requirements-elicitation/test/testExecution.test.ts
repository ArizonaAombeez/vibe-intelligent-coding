import { test } from 'node:test'
import assert from 'node:assert/strict'
import { triageTestFailure, confirmTestCaseFailure } from '../src/index.js'
import type { LlmCallOptions, LlmChatResult, LlmClient, LlmMessage, Project, TestRun } from '../src/index.js'

function emptyProject(): Project {
  return {
    schemaVersion: 1,
    id: 'proj-1',
    name: 'Test Project',
    projectMode: 'new',
    requirements: [],
    architecture: {
      // Minimal — only the fields formatArchitectureForTriage /
      // parseSuspectedElementIds read (id, kind, name, responsibility).
      elements: [
        { id: 'ARCH-001', kind: 'service', name: 'Login UI', responsibility: 'renders the login form' },
        { id: 'ARCH-002', kind: 'service', name: 'Auth API', responsibility: 'validates credentials' },
        { id: 'ARCH-HARNESS', kind: 'harness', name: 'Harness', responsibility: 'wires elements together' },
      ],
    } as unknown as Project['architecture'],
    testSuite: {
      tests: [
        {
          id: 'TEST-001',
          type: 'functional',
          title: 'Renders login form',
          requirementIds: ['REQ-001'],
          architectureElementId: 'ARCH-001',
          status: 'failing',
          createdAt: new Date().toISOString(),
        },
      ],
      nextTestSeq: 2,
    },
  }
}

function runWithFailingOutcome(): TestRun {
  return {
    id: 'TESTRUN-1',
    kind: 'element-scoped',
    architectureElementId: 'ARCH-001',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    exitCode: 1,
    rawLog: 'output here',
    outcomes: [{ testCaseId: 'TEST-001', passed: false, output: 'AssertionError: expected true' }],
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

test('triageTestFailure parses a CODE-FAILURE reply and mutates the outcome in place', async () => {
  const project = emptyProject()
  const run = runWithFailingOutcome()
  const fake = new FakeLlmClient('CODE-FAILURE: the login handler never checks the password field')

  const result = await triageTestFailure(project, fake, run, 'TEST-001')

  assert.equal(result.triage, 'code-failure')
  assert.match(result.triageRationale!, /password field/)
  assert.equal(run.outcomes[0].triage, 'code-failure')
})

test('triageTestFailure parses a TEST-CASE-FAILURE reply', async () => {
  const project = emptyProject()
  const run = runWithFailingOutcome()
  const fake = new FakeLlmClient('TEST-CASE-FAILURE: the assertion checks the wrong field name')

  const result = await triageTestFailure(project, fake, run, 'TEST-001')

  assert.equal(result.triage, 'test-case-failure')
  assert.equal(run.outcomes[0].testCaseFailureConfirmedAt, undefined, 'triage alone never auto-confirms')
})

test('triageTestFailure defaults to unattributed on a malformed reply', async () => {
  const project = emptyProject()
  const run = runWithFailingOutcome()
  const fake = new FakeLlmClient('I am not sure what happened here')

  const result = await triageTestFailure(project, fake, run, 'TEST-001')

  assert.equal(result.triage, 'unattributed')
})

test('triageTestFailure parses SUSPECTED-ELEMENTS and writes them to the outcome (advisory)', async () => {
  const project = emptyProject()
  const run = runWithFailingOutcome()
  const fake = new FakeLlmClient(
    'CODE-FAILURE: the harness never wires the auth client into the login UI\nSUSPECTED-ELEMENTS: ARCH-HARNESS, ARCH-002',
  )

  const result = await triageTestFailure(project, fake, run, 'TEST-001')

  assert.deepEqual(result.suspectedElementIds, ['ARCH-HARNESS', 'ARCH-002'])
  assert.deepEqual(run.outcomes[0].suspectedElementIds, ['ARCH-HARNESS', 'ARCH-002'])
  // Advisory only — triage verdict unaffected, nothing routed.
  assert.equal(result.triage, 'code-failure')
})

test('triageTestFailure falls back to the static link when SUSPECTED-ELEMENTS is missing or unknown', async () => {
  const project = emptyProject()
  const run = runWithFailingOutcome()
  const fake = new FakeLlmClient('CODE-FAILURE: something broke\nSUSPECTED-ELEMENTS: ARCH-BOGUS, not-an-id')

  const result = await triageTestFailure(project, fake, run, 'TEST-001')

  assert.deepEqual(result.suspectedElementIds, ['ARCH-001'])
})

test('triageTestFailure throws for a passing outcome', async () => {
  const project = emptyProject()
  const run = runWithFailingOutcome()
  run.outcomes[0].passed = true
  const fake = new FakeLlmClient('CODE-FAILURE: x')

  await assert.rejects(() => triageTestFailure(project, fake, run, 'TEST-001'), /passed/i)
})

test('confirmTestCaseFailure sets testCaseFailureConfirmedAt only when triage is test-case-failure', () => {
  const run = runWithFailingOutcome()
  run.outcomes[0].triage = 'test-case-failure'

  const outcome = confirmTestCaseFailure(run, 'TEST-001')

  assert.ok(outcome.testCaseFailureConfirmedAt)
})

test('confirmTestCaseFailure throws if the outcome is not triaged as test-case-failure', () => {
  const run = runWithFailingOutcome()
  run.outcomes[0].triage = 'code-failure'

  assert.throws(() => confirmTestCaseFailure(run, 'TEST-001'), /not currently triaged/)
})
