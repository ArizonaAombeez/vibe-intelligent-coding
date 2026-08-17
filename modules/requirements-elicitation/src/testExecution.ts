import { buildTestExecutionChatMessages, buildTriageMessages } from './testExecutionPersona.js'
import type { LlmCallOptions, LlmClient, LlmUsage } from './LlmClient.js'
import type { Project, TestCase, TestCaseOutcome, TestOutcomeTriage, TestRun } from './types.js'

function describeVerification(project: Project, testCaseId: string): string {
  const testCase = project.testSuite?.tests.find((t) => t.id === testCaseId)
  if (!testCase) return '(test case not found)'
  if (testCase.type === 'functional') {
    const byId = new Map(project.requirements.map((r) => [r.id, r]))
    return testCase.requirementIds
      .map((id) => byId.get(id))
      .filter((r): r is NonNullable<typeof r> => r !== undefined)
      .map((r) => `${r.id}: ${r.text}`)
      .join('\n')
  }
  const ref = testCase.interfaceContractRef
  if (!ref) return '(no contract reference)'
  const contract = (project.architecture?.interfaceContracts ?? []).find(
    (c) => [c.fromId, c.toId].sort().join('|') === [ref.fromId, ref.toId].sort().join('|'),
  )
  return contract ? `Interface contract ${ref.fromId} <-> ${ref.toId}` : '(contract not found)'
}

const CODE_FAILURE_LINE = /^CODE-FAILURE:\s*(.+)$/m
const TEST_CASE_FAILURE_LINE = /^TEST-CASE-FAILURE:\s*(.+)$/m

export interface TriageTestFailureResult {
  triage: TestOutcomeTriage
  triageRationale?: string
  usage?: LlmUsage
}

// Test failure triage (Area F, resolved) — parses a CODE-FAILURE:/
// TEST-CASE-FAILURE: reply and sets outcome.triage/triageRationale
// directly (by reference — mutates outcome in place, mirrors
// story.research). Defaults to 'unattributed' on a malformed/missing
// reply, never guessed. A 'test-case-failure' verdict is a PROPOSAL, not a
// final state that auto-amends anything — per the resolved rule, this
// function only sets the triage verdict; a separate, human-initiated
// confirmation (outcome.testCaseFailureConfirmedAt) is required before the
// status-flip gate (requirementStatusFlip.ts in vic-testing) stops holding
// this requirement's status.
export async function triageTestFailure(
  project: Project,
  llmClient: LlmClient,
  testRun: TestRun,
  testCaseId: string,
  llmOptions?: LlmCallOptions,
): Promise<TriageTestFailureResult> {
  const outcome = testRun.outcomes.find((o) => o.testCaseId === testCaseId)
  if (!outcome) {
    throw new Error(`Test case outcome for ${testCaseId} not found in run ${testRun.id}`)
  }
  if (outcome.passed) {
    throw new Error(`Test case ${testCaseId} passed in this run — nothing to triage`)
  }

  const testCase = project.testSuite?.tests.find((t) => t.id === testCaseId)
  const messages = buildTriageMessages(testCase?.title ?? testCaseId, describeVerification(project, testCaseId), outcome.output)
  const result = await llmClient.chat(messages, llmOptions)

  const codeFailure = result.content.match(CODE_FAILURE_LINE)
  const testCaseFailure = result.content.match(TEST_CASE_FAILURE_LINE)

  let triage: TestOutcomeTriage = 'unattributed'
  let triageRationale: string | undefined
  if (testCaseFailure) {
    triage = 'test-case-failure'
    triageRationale = testCaseFailure[1].trim()
  } else if (codeFailure) {
    triage = 'code-failure'
    triageRationale = codeFailure[1].trim()
  }

  outcome.triage = triage
  outcome.triageRationale = triageRationale
  return { triage, triageRationale, usage: result.usage }
}

// Human confirmation step (Area F, resolved: "a human confirms before the
// test is amended and re-run") — the ONLY path that lets a
// 'test-case-failure' triage stop blocking the status gate. Does not
// itself amend/regenerate the test file.
export function confirmTestCaseFailure(testRun: TestRun, testCaseId: string): TestCaseOutcome {
  const outcome = testRun.outcomes.find((o) => o.testCaseId === testCaseId)
  if (!outcome) {
    throw new Error(`Test case outcome for ${testCaseId} not found in run ${testRun.id}`)
  }
  if (outcome.triage !== 'test-case-failure') {
    throw new Error(`Test case ${testCaseId} is not currently triaged as test-case-failure`)
  }
  outcome.testCaseFailureConfirmedAt = new Date().toISOString()
  return outcome
}

export interface ChatWithQATestExecutionResult {
  reply: string
  usage?: LlmUsage
}

// QA Test-Execution-chat path (mirrors chatWithDev) — conversational only,
// never sets a triage verdict itself (see testExecutionPersona.ts's
// DEFAULT_QA_TEST_EXECUTION_SYSTEM_PROMPT). Does not mutate project state.
export async function chatWithQATestExecution(
  project: Project,
  llmClient: LlmClient,
  testCaseId: string | null,
  latestRunId: string | null,
  userMessage: string,
  llmOptions?: LlmCallOptions,
): Promise<ChatWithQATestExecutionResult> {
  const test: TestCase | null = testCaseId
    ? (project.testSuite?.tests.find((t) => t.id === testCaseId) ?? null)
    : null
  const latestRun: TestRun | null = latestRunId
    ? (project.testRuns?.find((r) => r.id === latestRunId) ?? null)
    : null

  const messages = buildTestExecutionChatMessages(test, latestRun, userMessage)
  const result = await llmClient.chat(messages, llmOptions)
  return {
    reply: result.content,
    usage: result.usage,
  }
}
