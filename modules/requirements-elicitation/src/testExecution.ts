import {
  buildTestExecutionChatMessages,
  buildTriageMessages,
  buildUserReportedIssueTriageMessages,
  formatArchitectureForTriage,
  formatLatestRun,
  formatTestCase,
} from './testExecutionPersona.js'
import { updateRequirementText } from './elicitation.js'
import type { LlmCallOptions, LlmClient, LlmMessage, LlmUsage } from './LlmClient.js'
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
  const definitionId = testCase.interfaceDefinitionId
  if (!definitionId) return '(no contract reference)'
  const definition = (project.architecture?.interfaceDefinitions ?? []).find((d) => d.id === definitionId)
  return definition ? `Interface contract ${definition.name}` : '(contract not found)'
}

const CODE_FAILURE_LINE = /^CODE-FAILURE:\s*(.+)$/m
const TEST_CASE_FAILURE_LINE = /^TEST-CASE-FAILURE:\s*(.+)$/m
const SUSPECTED_ELEMENTS_LINE = /^SUSPECTED-ELEMENTS:\s*(.+)$/m

// Parses the advisory "SUSPECTED-ELEMENTS: ELM-01, ELM-07" line the triage
// prompts now ask for, keeping only ids that are real architecture
// elements (dedup, order preserved). Falls back to the test's static link
// when the LLM named nothing usable — never returns an empty array so
// callers always have at least the static attribution to show.
function parseSuspectedElementIds(
  replyContent: string,
  project: Project,
  fallbackElementIds: string[],
): string[] {
  const line = replyContent.match(SUSPECTED_ELEMENTS_LINE)
  const known = new Set((project.architecture?.elements ?? []).map((e) => e.id))
  const parsed = line
    ? [...new Set(line[1].split(/[,\s]+/).map((s) => s.trim()).filter((s) => s.length > 0))].filter((id) => known.has(id))
    : []
  return parsed.length > 0 ? parsed : fallbackElementIds.filter((id) => known.has(id))
}

function staticElementIdsForTest(test: TestCase | undefined): string[] {
  if (!test) return []
  if (test.architectureElementId) return [test.architectureElementId]
  return test.interfaceElementIds ?? []
}

export interface TriageTestFailureResult {
  triage: TestOutcomeTriage
  triageRationale?: string
  // Architecture element id(s) the LLM suspects are at fault, most likely
  // first — always populated (falls back to the test's static link).
  // Advisory: also written to outcome.suspectedElementIds, never used to
  // route or gate.
  suspectedElementIds: string[]
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
  const staticElementIds = staticElementIdsForTest(testCase)
  const messages = buildTriageMessages(
    testCase?.title ?? testCaseId,
    describeVerification(project, testCaseId),
    outcome.output,
    formatArchitectureForTriage(project),
    staticElementIds[0] ?? null,
  )
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

  const suspectedElementIds = parseSuspectedElementIds(result.content, project, staticElementIds)

  outcome.triage = triage
  outcome.triageRationale = triageRationale
  outcome.suspectedElementIds = suspectedElementIds
  return { triage, triageRationale, suspectedElementIds, usage: result.usage }
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

// QA Test-Execution-chat path (Coding's former Dev chat was removed rather
// than mirrored — see "User-reported issue triage" in the spec) —
// conversational reply only; never sets a triage verdict or mutates
// project state itself (see testExecutionPersona.ts's
// DEFAULT_QA_TEST_EXECUTION_SYSTEM_PROMPT). Dispatch is a separate call —
// classifyAndDispatchUserReportedIssue below — invoked alongside this one
// by the server route, not by this function.
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

const USER_ISSUE_CODE_FAILURE_LINE = /^CODE-FAILURE:\s*(.+)$/m
const USER_ISSUE_TEST_CASE_FAILURE_LINE = /^TEST-CASE-FAILURE:\s*(.+)$/m
const USER_ISSUE_REQUIREMENT_ISSUE_LINE = /^REQUIREMENT-ISSUE:\s*(.+)$/m

export interface UserReportedIssueDispatch {
  verdict: 'code-failure' | 'test-case-failure' | 'requirement-issue'
  rationale: string
  dispatchedTo?: string
  // Architecture element id(s) the LLM suspects are at fault, most likely
  // first — always populated (falls back to the test's static link).
  // Advisory: does NOT change which element(s) pendingRecodeReason is set
  // on. Surfaced as chat link chips + rationale only.
  suspectedElementIds: string[]
}

export interface ClassifyUserReportedIssueResult {
  dispatch?: UserReportedIssueDispatch
  usage: LlmUsage[]
}

function buildAmendRequirementMessages(requirement: { id: string; text: string }, rationale: string, userMessage: string): LlmMessage[] {
  return [
    {
      role: 'system',
      content: `You are QA, drafting an amended requirement after triaging a user-reported issue as a requirement problem
(not a code or test problem). Given the requirement's current text, your own rationale for
why it's the requirement at fault, and the user's original description, write the corrected
requirement text. Reply with ONLY the new requirement text — no preamble, no explanation,
no surrounding quotes.`,
    },
    {
      role: 'user',
      content: `Requirement ${requirement.id} (current text): ${requirement.text}\n\nWhy this requirement needs to change: ${rationale}\n\nUser's original description: ${userMessage}`,
    },
  ]
}

// User-reported issue triage + auto-dispatch (Area F "User-reported issue
// triage", resolved) — the classification half of Test Execution's QA
// chat's dispatch power. Called by the server route alongside (not
// instead of) chatWithQATestExecution's plain conversational reply, over
// the same test/run/message. Requires a test in focus (testCaseId) — with
// nothing selected there is no element/requirement to dispatch to, so the
// route skips this call entirely rather than invoking it with nothing to
// attribute against.
//
// code-failure and requirement-issue both mutate project state
// immediately (no separate confirmation step) — mirrors how an automated
// code-failure verdict already flows straight into Coding via
// pendingRecodeReason with no human gate. test-case-failure returns the
// verdict only; unlike the automated-failure path (which has a TestRun
// outcome to attach testCaseFailureConfirmedAt to via
// confirmTestCaseFailure), a chat-reported issue has no run outcome to
// confirm against, so it's surfaced to the human as a proposal with no
// stored triage state — the human acts on it manually (edit/delete the
// test case) the same way they always could.
export async function classifyAndDispatchUserReportedIssue(
  project: Project,
  llmClient: LlmClient,
  testCaseId: string,
  latestRunId: string | null,
  userMessage: string,
  llmOptions?: LlmCallOptions,
  codeContext?: string,
): Promise<ClassifyUserReportedIssueResult> {
  const test = project.testSuite?.tests.find((t) => t.id === testCaseId)
  if (!test) {
    throw new Error(`Test case ${testCaseId} not found`)
  }
  const latestRun: TestRun | null = latestRunId ? (project.testRuns?.find((r) => r.id === latestRunId) ?? null) : null

  const staticElementIds = staticElementIdsForTest(test)
  const messages = buildUserReportedIssueTriageMessages(
    formatTestCase(test),
    describeVerification(project, testCaseId),
    formatLatestRun(latestRun, testCaseId),
    userMessage,
    formatArchitectureForTriage(project),
    staticElementIds[0] ?? null,
    codeContext,
  )
  const result = await llmClient.chat(messages, llmOptions)
  const usage: LlmUsage[] = result.usage ? [result.usage] : []

  if (result.content.trim() === 'NOT-AN-ISSUE-REPORT') {
    return { usage }
  }

  const codeFailure = result.content.match(USER_ISSUE_CODE_FAILURE_LINE)
  const testCaseFailure = result.content.match(USER_ISSUE_TEST_CASE_FAILURE_LINE)
  const requirementIssue = result.content.match(USER_ISSUE_REQUIREMENT_ISSUE_LINE)
  const suspectedElementIds = parseSuspectedElementIds(result.content, project, staticElementIds)

  if (testCaseFailure) {
    return { dispatch: { verdict: 'test-case-failure', rationale: testCaseFailure[1].trim(), suspectedElementIds }, usage }
  }

  if (requirementIssue && test.type === 'functional' && test.requirementIds[0]) {
    const rationale = requirementIssue[1].trim()
    const requirement = project.requirements.find((r) => r.id === test.requirementIds[0] && !r.deletedAt)
    if (requirement) {
      const draftMessages = buildAmendRequirementMessages(requirement, rationale, userMessage)
      const draftResult = await llmClient.chat(draftMessages, llmOptions)
      if (draftResult.usage) usage.push(draftResult.usage)
      const newText = draftResult.content.trim()
      if (newText) {
        updateRequirementText(project, requirement.id, newText)
        return { dispatch: { verdict: 'requirement-issue', rationale, dispatchedTo: requirement.id, suspectedElementIds }, usage }
      }
    }
    // Fall through to code-failure treatment if there's no single
    // requirement to amend (integration test, or the drafted text came
    // back empty) — same "default to CODE-FAILURE when uncertain" rule
    // the persona prompt already states for its own uncertainty.
  }

  const rationale = (codeFailure?.[1] ?? requirementIssue?.[1] ?? '').trim() || 'Reported by user in Test Execution chat.'
  // A functional test's code failure dispatches to its one element. An
  // integration test's code failure dispatches to BOTH connected elements
  // — same treatment interfaceChangedSinceLastCoding already gives an
  // interface-contract change, since either side (or both) could be where
  // the reported behavior actually breaks and there's no reliable signal
  // here to pick just one.
  const targetElementIds = test.architectureElementId
    ? [test.architectureElementId]
    : (test.interfaceElementIds ?? [])
  const dispatchedIds: string[] = []
  for (const elementId of targetElementIds) {
    const element = project.architecture?.elements.find((e) => e.id === elementId)
    if (!element) continue
    element.pendingRecodeReason = 'user-reported-issue'
    element.pendingRecodeDetail = userMessage
    dispatchedIds.push(element.id)
  }

  return {
    dispatch: { verdict: 'code-failure', rationale, dispatchedTo: dispatchedIds.join(', ') || undefined, suspectedElementIds },
    usage,
  }
}
