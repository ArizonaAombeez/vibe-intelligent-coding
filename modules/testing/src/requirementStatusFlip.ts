import type { Project, TestCase, TestCaseOutcome } from 'vic-requirements-elicitation'

export interface ApplyPassThresholdResult {
  flippedToTested: string[]
  flippedToComplete: string[]
  regressed: string[]
}

// Maps each requirement id to the outcomes (from this run only) of every
// test that traces to it — a functional TestCase's own requirementIds,
// plus any integration TestCase whose interfaceElementIds includes the
// requirement's allocated architecture element (an interface test partly
// verifies both sides of the connection it covers).
function outcomesByRequirementId(
  project: Project,
  testCases: TestCase[],
  outcomes: TestCaseOutcome[],
): Map<string, TestCaseOutcome[]> {
  const testById = new Map(testCases.map((t) => [t.id, t]))
  const map = new Map<string, TestCaseOutcome[]>()

  function add(requirementId: string, outcome: TestCaseOutcome) {
    const list = map.get(requirementId) ?? []
    list.push(outcome)
    map.set(requirementId, list)
  }

  for (const outcome of outcomes) {
    const testCase = testById.get(outcome.testCaseId)
    if (!testCase) continue
    if (testCase.type === 'functional') {
      for (const reqId of testCase.requirementIds) add(reqId, outcome)
    } else if (testCase.interfaceElementIds) {
      for (const requirement of project.requirements) {
        if (
          !requirement.deletedAt &&
          requirement.architectureElements.some((id) => testCase.interfaceElementIds!.includes(id))
        ) {
          add(requirement.id, outcome)
        }
      }
    }
  }
  return map
}

// The mechanical pass-threshold requirement-status flip (Area F,
// resolved). Pure, non-LLM — no filesystem/subprocess dependency, called
// from runElementTestSuite/runFullRegression immediately after outcomes
// are known, before the TestRun/TestRegressionRun record is returned (the
// gate is inline in the orchestration, not a step the caller might skip,
// same pattern as vic-coding's enforceWriteScope being called from inside
// runCodingForStory).
//
// Logic per requirement with >=1 outcome in this run's set:
// - All-pass, !isFullRegressionPass, current status 'coded' -> 'tested'.
// - All-pass, isFullRegressionPass, current status 'tested' -> 'complete'
//   (a deliberately later, second gate — a requirement is not marked fully
//   done on the strength of an isolated run that never re-confirmed it
//   still holds alongside everything else).
// - Any-fail, current status 'complete' or 'tested' -> 'tested-fail' (testing
//   was performed for this run and it failed — distinct from 'coded', which
//   means no test verdict has been recorded yet).
// - Any-fail with at least one failing test still 'unattributed' (or a
//   'test-case-failure' pending human confirmation) -> status change is
//   held entirely — this is the literal code enforcement of "no
//   requirement status change happens on a failing test until the cause
//   is attributed."
// - A requirement with zero outcomes in this run's set is left untouched
//   ("no evidence either way" must never be conflated with "passed").
export function applyPassThreshold(
  project: Project,
  testCases: TestCase[],
  outcomes: TestCaseOutcome[],
  isFullRegressionPass: boolean,
): ApplyPassThresholdResult {
  const byRequirement = outcomesByRequirementId(project, testCases, outcomes)
  const result: ApplyPassThresholdResult = { flippedToTested: [], flippedToComplete: [], regressed: [] }

  for (const [requirementId, reqOutcomes] of byRequirement) {
    const requirement = project.requirements.find((r) => r.id === requirementId && !r.deletedAt)
    if (!requirement) continue

    const failing = reqOutcomes.filter((o) => !o.passed)
    const allPassed = failing.length === 0

    if (!allPassed) {
      const blocked = failing.some(
        (o) => !o.triage || o.triage === 'unattributed' || (o.triage === 'test-case-failure' && !o.testCaseFailureConfirmedAt),
      )
      if (blocked) continue // status change held until triage/confirmation completes

      if (requirement.status === 'complete' || requirement.status === 'tested') {
        requirement.status = 'tested-fail'
        result.regressed.push(requirementId)
      }
      continue
    }

    if (isFullRegressionPass) {
      if (requirement.status === 'tested') {
        requirement.status = 'complete'
        result.flippedToComplete.push(requirementId)
      }
    } else if (requirement.status === 'coded') {
      requirement.status = 'tested'
      result.flippedToTested.push(requirementId)
    }
  }

  return result
}
