import type { LlmMessage } from './LlmClient.js'
import type { Project, TestCase, TestRun } from './types.js'

// Total character budget for code files folded into the user-reported-
// issue triage call's context — same rough token-cap proxy (~4 chars/
// token) the removed Dev-chat persona used for its own code context, kept
// here since triage's code context serves the same "help the LLM see the
// real implementation" purpose that chat's did.
const CODE_CONTEXT_CHAR_BUDGET = 40_000

export function formatCodeContextForTriage(files: Array<{ path: string; content: string }>): string | undefined {
  if (files.length === 0) return undefined
  const included: Array<{ path: string; content: string }> = []
  let used = 0
  let omitted = 0
  for (const file of files) {
    if (used + file.content.length > CODE_CONTEXT_CHAR_BUDGET) {
      omitted++
      continue
    }
    included.push(file)
    used += file.content.length
  }
  const body = included.map((f) => `--- ${f.path} ---\n${f.content}`).join('\n\n')
  const omittedNote = omitted > 0 ? `\n\n(${omitted} additional file(s) omitted — over the context budget)` : ''
  return `Element's current source files:\n\n${body}${omittedNote}`
}

// One line per architecture element (id, kind, name, responsibility),
// including the single kind:'harness' element — folded into both triage
// prompts so the LLM can name which element(s) it actually suspects are at
// fault rather than being limited to the test's static
// architectureElementId. The fault often lies in a collaborator or in the
// Harness wiring; this list is what lets triage say so. The verdict this
// produces (SUSPECTED-ELEMENTS: line) is ADVISORY — see
// TestCaseOutcome.suspectedElementIds.
export function formatArchitectureForTriage(project: Project): string {
  const elements = project.architecture?.elements ?? []
  if (elements.length === 0) return '(no architecture elements defined)'
  return elements
    .map((e) => `${e.id} (${e.kind}) ${e.name} — ${e.responsibility}`)
    .join('\n')
}

// Appended to both triage user messages: the element list plus a nudge
// that the static link is a starting point, not a conclusion.
function architectureContextBlock(architectureContext: string, staticElementHint: string): string {
  return `Architecture elements (the failure should be attributable to one or more of these):
${architectureContext}

${staticElementHint}
After your verdict line, add exactly one more line naming the element id(s)
you actually suspect are at fault, most likely first:

SUSPECTED-ELEMENTS: <comma-separated element ids>

If you have no reason to suspect anything other than the element the test
is linked to, just name that one.`
}

// Test failure triage (Area F, resolved) — every failure must be
// attributed to code-failure, test-case-failure, or requirement-issue
// before any status change occurs; a 'test-case-failure' verdict is
// mandatory-human-review, never auto-corrected/auto-discarded. The other
// two auto-dispatch (see "User-reported issue triage" in the spec) — this
// same three-way grammar is shared by both the automated test-run failure
// path (triageTestFailure) and the user-reported-issue chat path
// (classifyUserReportedIssue) below, since both are answering the same
// underlying question about the same kind of evidence.
export const TEST_FAILURE_TRIAGE_SYSTEM_PROMPT = `You are QA, triaging a failing test. Given the test's title, the
requirement(s) or interface contract operation it verifies, and the test
command's captured output, decide whether the failure means:

- the implementation is wrong (the code does not satisfy the requirement)
- the test itself is wrong (the test's own logic or assertions are
  incorrect, independent of whether the implementation is correct)
- the requirement itself is wrong, ambiguous, or missing something (the
  test and implementation may both be doing exactly what the requirement
  says, but the requirement text itself needs to change)

Your reply is exactly two lines. The first is one of these three verdict
formats:

CODE-FAILURE: <short rationale>
TEST-CASE-FAILURE: <short rationale>
REQUIREMENT-ISSUE: <short rationale>

The second line names the architecture element id(s) you suspect are at
fault (see the SUSPECTED-ELEMENTS instruction in the user message). Output
nothing else.

Only reply TEST-CASE-FAILURE if you are confident the test itself, not the
implementation or the requirement, is at fault — this is expected to be
rare. Only reply REQUIREMENT-ISSUE if the requirement's own text is what
needs to change, not just the code that implements it. If you are
genuinely unsure, reply CODE-FAILURE and explain the uncertainty in the
rationale (a suspected-but-unconfirmed test or requirement problem should
still default to CODE-FAILURE, since a code-failure verdict feeds back to
Coding for rework rather than blocking on a human, and rework can reveal a
test or requirement problem indirectly).`

export function buildTriageMessages(
  testTitle: string,
  verifies: string,
  output: string,
  architectureContext: string,
  staticElementId: string | null,
): LlmMessage[] {
  const hint = staticElementId
    ? `The test is statically linked to element ${staticElementId}, but the real fault may lie in a collaborator it calls, or in the Harness wiring.\n`
    : `The test has no single statically-linked element.\n`
  return [
    { role: 'system', content: TEST_FAILURE_TRIAGE_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Test: ${testTitle}\nVerifies: ${verifies}\n\nTest command output:\n${output}\n\n${architectureContextBlock(architectureContext, hint)}`,
    },
  ]
}

// User-reported issue triage (Area F "User-reported issue triage",
// resolved) — same three-way verdict as buildTriageMessages, but the
// evidence is a human's free-text description instead of a captured test
// command's output, and (optionally) the element's own current source
// rather than a specific failing run. Used by Test Execution's QA chat
// (the tool's one dispatch-capable chat surface) to decide whether a
// described problem is a code failure, a test case failure, or a
// requirement issue, before dispatching per classifyUserReportedIssue's
// caller in testExecution.ts.
const USER_REPORTED_ISSUE_TRIAGE_SYSTEM_PROMPT = `You are QA, triaging a problem a human tester has described in their own
words while testing a specific test case. Given the test's title, the
requirement(s) or interface contract operation it verifies, the most
recent run's outcome (if any), the user's description of what they saw,
and (if provided) the element's current source code, decide whether the
described problem means:

- the implementation is wrong (the code does not satisfy the requirement)
- the test itself is wrong or missing what the user described
- the requirement itself is wrong, ambiguous, or missing what the user
  described

If the message IS describing a problem with this test case, your reply is
exactly two lines. The first is one of these three verdict formats:

CODE-FAILURE: <short rationale>
TEST-CASE-FAILURE: <short rationale>
REQUIREMENT-ISSUE: <short rationale>

The second line names the architecture element id(s) you suspect are at
fault (see the SUSPECTED-ELEMENTS instruction below).

If the message is not actually describing a problem with this test case
(e.g. a general question, or discussion that isn't reporting an issue),
reply with exactly this single line and nothing else:

NOT-AN-ISSUE-REPORT

Only reply TEST-CASE-FAILURE if you are confident the test itself is at
fault — this is expected to be rare. When genuinely unsure between
CODE-FAILURE and REQUIREMENT-ISSUE, prefer CODE-FAILURE and explain the
uncertainty in the rationale, since a code-failure verdict is easier to
revise later (another Coding run) than a requirement-text change.`

export function buildUserReportedIssueTriageMessages(
  testTitle: string,
  verifies: string,
  latestRunSummary: string,
  userMessage: string,
  architectureContext: string,
  staticElementId: string | null,
  codeContext?: string,
): LlmMessage[] {
  const hint = staticElementId
    ? `The test is statically linked to element ${staticElementId}, but the real fault may lie in a collaborator it calls, or in the Harness wiring.\n`
    : `The test has no single statically-linked element.\n`
  const parts = [
    `Test: ${testTitle}`,
    `Verifies: ${verifies}`,
    `Most recent run: ${latestRunSummary}`,
    `User's description of the problem:\n${userMessage}`,
  ]
  if (codeContext) parts.push(codeContext)
  parts.push(architectureContextBlock(architectureContext, hint))
  return [
    { role: 'system', content: USER_REPORTED_ISSUE_TRIAGE_SYSTEM_PROMPT },
    { role: 'user', content: parts.join('\n\n') },
  ]
}

// Test Execution chat's conversational reply (Area F "User-reported issue
// triage", resolved) — this is the tool's one dispatch-capable chat
// surface (Coding's former Dev chat was removed rather than mirrored, per
// that same resolved section), but dispatch itself is a SEPARATE
// classification call (buildUserReportedIssueTriageMessages above,
// invoked by classifyUserReportedIssue in testExecution.ts) run alongside
// this one, not something this conversational prompt does inline — same
// separation-of-concerns as triageTestFailure being a distinct call from
// this chat already was.
export const DEFAULT_QA_TEST_EXECUTION_SYSTEM_PROMPT = `You are QA, responsible for the Test Execution stage of a software project. You help
the user interpret a test run's output, discuss why a test might be failing, or think
through mutation testing results.

You do not set a test's triage verdict directly in this reply — a separate
classification step decides that from the same message. Just respond
conversationally: help interpret raw test output, discuss whether a failure looks like
a code problem, a test problem, or a requirement problem, or explain a mutation score.`

export function formatTestCase(test: TestCase): string {
  const verifies =
    test.type === 'functional'
      ? `requirements ${test.requirementIds.join(', ') || '(none)'}`
      : `interface ${test.interfaceElementIds?.[0]} <-> ${test.interfaceElementIds?.[1]}`
  return `${test.id}: ${test.title} (${test.type}) — verifies ${verifies}`
}

export function formatLatestRun(run: TestRun | null, testCaseId: string | null): string {
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
