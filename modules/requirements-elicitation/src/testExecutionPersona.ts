import type { LlmMessage } from './LlmClient.js'
import type { TestCase, TestRun } from './types.js'

// Test failure triage (Area F, resolved) — every failure must be
// attributed to code-failure or test-case-failure before any status
// change occurs; a 'test-case-failure' verdict is mandatory-human-review,
// never auto-corrected/auto-discarded.
export const TEST_FAILURE_TRIAGE_SYSTEM_PROMPT = `You are QA, triaging a failing test. Given the test's title, the
requirement(s) or interface contract operation it verifies, and the test
command's captured output, decide whether the failure means:

- the implementation is wrong (the code does not satisfy the requirement)
- the test itself is wrong (the test's own logic or assertions are
  incorrect, independent of whether the implementation is correct)

Reply using exactly one of these two line formats, nothing else:

CODE-FAILURE: <short rationale>
TEST-CASE-FAILURE: <short rationale>

Only reply TEST-CASE-FAILURE if you are confident the test itself, not the
implementation, is at fault — this is expected to be rare. If you are
genuinely unsure, reply CODE-FAILURE and explain the uncertainty in the
rationale (a suspected-but-unconfirmed test problem should still default
to CODE-FAILURE, since a code-failure verdict feeds back to Coding for
rework rather than blocking on a human, and rework can reveal a test
problem indirectly).`

export function buildTriageMessages(testTitle: string, verifies: string, output: string): LlmMessage[] {
  return [
    { role: 'system', content: TEST_FAILURE_TRIAGE_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Test: ${testTitle}\nVerifies: ${verifies}\n\nTest command output:\n${output}`,
    },
  ]
}

// Test Execution chat (Area F) — open-ended QA chat, mirrors
// buildAnalystChatMessages/buildArchitectChatMessages/buildPlanningChatMessages/
// buildTestCreationChatMessages. Deliberately never proposes anything —
// triage verdicts only ever come from the dedicated Run Triage action
// (triageTestFailure, its own CODE-FAILURE:/TEST-CASE-FAILURE: grammar),
// never from this chat, so this persona is purely conversational.
export const DEFAULT_QA_TEST_EXECUTION_SYSTEM_PROMPT = `You are QA, responsible for the Test Execution stage of a software project. You help
the user interpret a test run's output, discuss why a test might be failing, or think
through mutation testing results.

You do not set a test's triage verdict in this conversation — that only happens via the
dedicated Run Triage action. Just respond conversationally: help interpret raw test
output, discuss whether a failure looks like a code problem or a test problem, or
explain a mutation score.`

function formatTestCase(test: TestCase): string {
  const verifies =
    test.type === 'functional'
      ? `requirements ${test.requirementIds.join(', ') || '(none)'}`
      : `interface ${test.interfaceContractRef?.fromId} <-> ${test.interfaceContractRef?.toId}`
  return `${test.id}: ${test.title} (${test.type}) — verifies ${verifies}`
}

function formatLatestRun(run: TestRun | null, testCaseId: string | null): string {
  if (!run || !testCaseId) return 'No test run currently in focus.'
  const outcome = run.outcomes.find((o) => o.testCaseId === testCaseId)
  if (!outcome) return 'No outcome found for this test in the run in focus.'
  const status = outcome.passed ? 'passed' : 'failed'
  const triage = outcome.triage ? ` (triage: ${outcome.triage}${outcome.triageRationale ? ` — ${outcome.triageRationale}` : ''})` : ''
  return `Latest run (${run.startedAt}): ${status}${triage}\nOutput:\n${outcome.output}`
}

export function buildTestExecutionChatMessages(
  test: TestCase | null,
  latestRun: TestRun | null,
  userMessage: string,
  systemPrompt: string = DEFAULT_QA_TEST_EXECUTION_SYSTEM_PROMPT,
): LlmMessage[] {
  const context = test
    ? `Test in focus:\n${formatTestCase(test)}\n\n${formatLatestRun(latestRun, test.id)}`
    : 'No test currently selected.'

  return [
    { role: 'system', content: systemPrompt },
    { role: 'system', content: context },
    { role: 'user', content: userMessage },
  ]
}
