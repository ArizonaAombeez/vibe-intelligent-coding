import { checkInterfaces } from './architecture.js'
import type { Project } from './types.js'

// Real, computed phase status — replaces the UI's hardcoded defaultPhases()
// literal, which was a fixed set of 'not-started'/'in-progress' strings that
// nothing ever recomputed from project state (so phaseTabGating had nothing
// to gate on, and the Coding tab happily let you in with a half-built
// architecture). Modeled on modules/testing/src/scopeReadiness.ts: a pure
// function over Project, no disk I/O, exposed via one server route.
//
// Deliberately NOT wired to hard-block navigation — phaseTabGating stays
// 'always-accessible'. The value is the visible blocker surface (a banner on
// the target screen with a one-click fix), not locked tabs, which people on
// a non-linear tool experience as a regression.

export type PhaseId =
  | 'dashboard'
  | 'requirements'
  | 'architecture'
  | 'test-creation'
  | 'coding'
  | 'test-execution'

export type PhaseStatus = 'not-started' | 'in-progress' | 'blocked' | 'complete'

export interface PhaseBlocker {
  phaseId: PhaseId
  // One sentence the user reads on the target screen's banner.
  reason: string
  // Which screen/action resolves it — the UI turns this into a link.
  fixPhaseId: PhaseId
  fixLabel: string
}

export interface PhaseReadiness {
  statuses: Record<PhaseId, PhaseStatus>
  blockers: PhaseBlocker[]
}

function activeRequirements(project: Project) {
  return project.requirements.filter((r) => !r.deletedAt)
}

function nonHarnessElements(project: Project) {
  return (project.architecture?.elements ?? []).filter((e) => e.kind !== 'harness')
}

function hasSuccessfulCodingRun(project: Project, elementId: string): boolean {
  return (project.codingRuns ?? []).some(
    (r) => r.architectureElementId === elementId && r.status === 'success',
  )
}

export function computePhaseReadiness(project: Project): PhaseReadiness {
  const blockers: PhaseBlocker[] = []
  const reqs = activeRequirements(project)
  const elements = nonHarnessElements(project)
  const architecture = project.architecture

  // --- requirements -------------------------------------------------------
  let requirements: PhaseStatus
  if (reqs.length === 0) {
    requirements = 'not-started'
  } else if (reqs.every((r) => r.architectureElements.length > 0)) {
    requirements = 'complete'
  } else {
    requirements = 'in-progress'
  }

  // --- architecture ------------------------------------------------------
  // Complete requires: an architecture with >=1 non-harness element, a
  // platform, a harness spec derived for THAT platform, and a clean
  // checkInterfaces. Each false condition is a concrete blocker whose text
  // reuses harnessGateReason's wording where it applies.
  let architectureStatus: PhaseStatus
  if (!architecture || elements.length === 0) {
    architectureStatus = reqs.length > 0 ? 'in-progress' : 'not-started'
  } else {
    const harness = architecture.elements.find((e) => e.kind === 'harness')
    const spec = harness?.harnessSpec
    const interfaceResult = checkInterfaces(project)

    const problems: string[] = []
    if (!project.platform) {
      problems.push('no platform is selected')
      blockers.push({
        phaseId: 'architecture',
        reason:
          'No platform is selected for this project — pick one on the Architecture screen. This also derives the Harness.',
        fixPhaseId: 'architecture',
        fixLabel: 'Choose a platform',
      })
    } else if (!spec) {
      problems.push('the Harness has not been derived')
      blockers.push({
        phaseId: 'architecture',
        reason:
          'The Harness has not been derived yet — run Define Harness on the Architecture screen. Coding the Harness is refused until it exists.',
        fixPhaseId: 'architecture',
        fixLabel: 'Define Harness',
      })
    } else if (spec.derivedForPlatform !== project.platform) {
      problems.push('the Harness was derived for a different platform')
      blockers.push({
        phaseId: 'architecture',
        reason: `The Harness was derived for platform "${spec.derivedForPlatform}" but the project's platform is now "${project.platform}" — run Define Harness again.`,
        fixPhaseId: 'architecture',
        fixLabel: 'Re-derive Harness',
      })
    }
    if (!interfaceResult.complete) {
      problems.push('interface definitions are incomplete')
      blockers.push({
        phaseId: 'architecture',
        reason:
          'One or more inter-element interfaces are undefined, incomplete, or misaligned — open Check Interfaces on the Architecture screen. Coding an affected element is refused until this is resolved.',
        fixPhaseId: 'architecture',
        fixLabel: 'Check Interfaces',
      })
    }

    architectureStatus = problems.length === 0 ? 'complete' : 'in-progress'
  }

  // --- test-creation ---------------------------------------------------
  // Complete when every non-deleted test case has a generated file. "Not a
  // test file" pointers were already cleared to undefined by
  // reconcileTestCaseFiles (T1.3), so a plain !filePath check is enough.
  const testCases = (project.testSuite?.tests ?? []).filter((t) => !t.deletedAt)
  let testCreation: PhaseStatus
  if (testCases.length === 0) {
    testCreation = elements.length > 0 && architectureStatus === 'complete' ? 'in-progress' : 'not-started'
  } else if (testCases.every((t) => t.filePath)) {
    testCreation = 'complete'
  } else {
    testCreation = 'in-progress'
    blockers.push({
      phaseId: 'test-creation',
      reason: `${testCases.filter((t) => !t.filePath).length} test case(s) have no generated automation — run "Generate All Test Case Automations". Test Execution has nothing to run for them until then.`,
      fixPhaseId: 'test-creation',
      fixLabel: 'Generate automations',
    })
  }

  // --- coding ---------------------------------------------------------
  let coding: PhaseStatus
  if (elements.length === 0) {
    coding = 'not-started'
  } else {
    const codedCount = elements.filter((e) => hasSuccessfulCodingRun(project, e.id)).length
    const testsFailing = (project.codingRuns ?? []).some(
      (r) => r.status === 'success-tests-failing',
    )
    // A tests-failing run is real coding work that landed but doesn't pass —
    // 'blocked' regardless of how many other elements are green.
    if (testsFailing) coding = 'blocked'
    else if (codedCount === 0) coding = 'not-started'
    else if (codedCount === elements.length) coding = 'complete'
    else coding = 'in-progress'
  }

  // --- test-execution -----------------------------------------------
  // 'complete' requires the last full regression to have genuinely passed
  // over a non-empty outcome set. `outcomeCount` was added with the
  // `[].every()` fix (T1.5); a legacy record predating it has
  // outcomeCount === undefined AND allPassed possibly stale-true over zero
  // outcomes, so treat a missing outcomeCount as "cannot confirm" and fall
  // back to whether every non-deleted test case has a passing outcome.
  const anyOutcome = (project.testRuns ?? []).some((r) => r.outcomes.length > 0)
  const lastRegression = (project.testRegressionRuns ?? []).at(-1)
  const allTestCasesPass =
    testCases.length > 0 &&
    testCases.every((t) => t.status === 'passing')
  let testExecution: PhaseStatus
  if (!anyOutcome) {
    testExecution = coding === 'complete' ? 'in-progress' : 'not-started'
  } else if (
    lastRegression?.allPassed &&
    (lastRegression.outcomeCount === undefined
      ? allTestCasesPass
      : lastRegression.outcomeCount > 0)
  ) {
    testExecution = 'complete'
  } else {
    testExecution = 'in-progress'
  }

  return {
    statuses: {
      dashboard: 'in-progress',
      requirements,
      architecture: architectureStatus,
      'test-creation': testCreation,
      coding,
      'test-execution': testExecution,
    },
    blockers,
  }
}
