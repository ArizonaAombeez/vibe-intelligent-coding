import { elementSubfolderName, sourceTreeRoot } from 'vic-coding'
import { connectedPairs } from 'vic-requirements-elicitation'
import type { Project, TestCase, TestCaseOutcome, TestRegressionRun, TestRun } from 'vic-requirements-elicitation'
import { resolveExecutionScope } from './executionScopeGate.js'
import { readElementTestCommand } from './testCommandResolution.js'
import { runTestCommand } from './testRunner.js'
import { applyPassThreshold } from './requirementStatusFlip.js'

function elementSubfolderById(project: Project): Map<string, string> {
  const map = new Map<string, string>()
  for (const element of project.architecture?.elements ?? []) {
    map.set(element.id, elementSubfolderName(element))
  }
  return map
}

function activeTestsForScope(
  testSuite: Project['testSuite'],
  architectureElementId?: string,
  interfaceElementIds?: [string, string],
): TestCase[] {
  const tests = (testSuite?.tests ?? []).filter((t) => !t.deletedAt)
  if (interfaceElementIds) {
    const key = [...interfaceElementIds].sort().join('|')
    return tests.filter((t) => t.interfaceElementIds && [...t.interfaceElementIds].sort().join('|') === key)
  }
  return tests.filter((t) => t.architectureElementId === architectureElementId)
}

// Pragmatic per-test outcome attribution (confirmed acceptable for v1):
// tries a handful of common pass/fail line patterns (Jest/Vitest/Mocha's
// checkmark-ish "✓ <name>"/"✗ <name>", "PASS"/"FAIL <name>", pytest's
// "<name> PASSED"/"<name> FAILED"). If none of a scope's test titles can
// be matched against the output this way, every TestCase in the scope
// shares one aggregate outcome (the whole command's exit code) rather than
// guessing — a real, load-bearing v1 simplification, not full generality.
const PASS_PATTERNS = [/✓\s*(.+)$/m, /PASS(?:ED)?\s+(.+)$/m]
const FAIL_PATTERNS = [/[✗x]\s*(.+)$/m, /FAIL(?:ED)?\s+(.+)$/m]

// Only a TestCase with a generated file (filePath set by a prior "Generate
// Test File" run — see writeTestFiles.ts) can have actually contributed to
// this command's exit code or output; one with no file yet has no test code
// backing it. Excluded before attribution runs, in both the per-title-match
// and aggregate-fallback branches — a title match against a file-less test
// case would be coincidental, not meaningful, and the aggregate fallback
// existing at all is exactly what let a real test's pass silently vouch for
// unrelated, never-generated test cases sharing the same element scope
// (confirmed real behavior, not hypothetical: running one generated test
// among several ungenerated ones previously marked all of them "passing").
function attributeOutcomes(testCases: TestCase[], stdout: string, exitCode: number | null): TestCaseOutcome[] {
  const generated = testCases.filter((t) => t.filePath)
  if (generated.length === 0) return []

  const lines = stdout.split('\n')
  const passedTitles = new Set<string>()
  const failedTitles = new Set<string>()

  for (const line of lines) {
    for (const pattern of PASS_PATTERNS) {
      const m = line.match(pattern)
      if (m) passedTitles.add(m[1].trim())
    }
    for (const pattern of FAIL_PATTERNS) {
      const m = line.match(pattern)
      if (m) failedTitles.add(m[1].trim())
    }
  }

  const anyMatched = generated.some((t) => passedTitles.has(t.title) || failedTitles.has(t.title))
  if (anyMatched) {
    return generated.map((t) => ({
      testCaseId: t.id,
      passed: passedTitles.has(t.title) && !failedTitles.has(t.title),
      output: stdout,
    }))
  }

  // Aggregate fallback: exit code 0 means every generated test in this
  // scope passed; non-zero means every generated test in this scope is
  // marked failed (unattributed triage until a human/LLM sorts out which
  // one(s) actually broke).
  const aggregatePassed = exitCode === 0
  return generated.map((t) => ({ testCaseId: t.id, passed: aggregatePassed, output: stdout }))
}

function requireTestRuns(project: Project): TestRun[] {
  if (!project.testRuns) project.testRuns = []
  return project.testRuns
}

export interface RunElementTestSuiteScope {
  architectureElementId?: string
  interfaceElementIds?: [string, string]
}

// Element-scoped test run (Area F, resolved) — resolves scope (rejects
// before spawning a subprocess for an unresolvable scope, same "no
// subprocess cost for a rejected scope" economy as Coding), runs the
// element's own test command once (a single invocation covers every test
// file already written into that subfolder — most frameworks report at
// suite level, not per-invocation), attributes per-test outcomes
// pragmatically, and persists a new TestRun onto project.testRuns.
//
// Deliberately does NOT apply the pass-threshold status flip itself — a
// freshly-failed outcome has no triage yet by construction (triage is a
// separate, later LLM call against this run's own outcome), so flipping
// status inline here would always evaluate untriaged failures as "blocked"
// and could never be revisited once this run's outcomes exist: the next
// run creates entirely new outcome objects, and triage-after-the-fact on
// an old run's outcome would have nothing left to affect. Callers apply
// the flip explicitly via evaluateRequirementStatus — once right after a
// run (covers the immediate all-pass case) and again after triage
// completes for any failure (see triageTestFailure/confirmTestCaseFailure
// server routes), re-evaluating that SAME run's already-recorded outcomes
// rather than re-running the test command.
export async function runElementTestSuite(
  project: Project,
  projectDir: string,
  scope: RunElementTestSuiteScope,
  // Internal — set by runFullRegression's own sub-calls so this function
  // skips its own standalone status-flip evaluation and leaves that to the
  // caller's aggregate evaluateRequirementStatusForRegression call
  // instead. An on-demand single-element run (the normal, external call
  // shape) always evaluates its own flip immediately.
  skipStatusEvaluation = false,
): Promise<TestRun> {
  const startedAt = new Date().toISOString()
  const entity = {
    architectureElementId: scope.architectureElementId ?? null,
    interfaceElementIds: scope.interfaceElementIds,
  }
  const srcRoot = sourceTreeRoot(projectDir)
  const resolved = resolveExecutionScope(entity, elementSubfolderById(project), srcRoot)

  if ('rejected' in resolved) {
    const run: TestRun = {
      id: `TESTRUN-${startedAt}`,
      kind: 'element-scoped',
      architectureElementId: scope.architectureElementId ?? null,
      interfaceElementIds: scope.interfaceElementIds,
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode: null,
      rawLog:
        resolved.rejected === 'scope-not-found'
          ? 'This element/interface pair has not been scaffolded/coded yet — nothing to test.'
          : 'Could not resolve a single element/interface scope for this test run.',
      outcomes: [],
    }
    requireTestRuns(project).push(run)
    return run
  }

  const testCases = activeTestsForScope(project.testSuite, scope.architectureElementId, scope.interfaceElementIds)
  const testCommand = await readElementTestCommand(srcRoot, resolved.allowedRelativePrefix, project.testCommand)
  const commandResult = await runTestCommand({
    command: testCommand.command,
    args: testCommand.args,
    cwd: resolved.cwd,
  })

  const outcomes = attributeOutcomes(testCases, commandResult.stdout, commandResult.exitCode)
  for (const outcome of outcomes) {
    const testCase = testCases.find((t) => t.id === outcome.testCaseId)
    if (testCase) {
      testCase.status = outcome.passed ? 'passing' : 'failing'
      testCase.lastRunAt = new Date().toISOString()
    }
  }

  const run: TestRun = {
    id: `TESTRUN-${startedAt}`,
    kind: 'element-scoped',
    architectureElementId: scope.architectureElementId ?? null,
    interfaceElementIds: scope.interfaceElementIds,
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: commandResult.exitCode,
    rawLog: commandResult.stdout + (commandResult.stderr ? `\n${commandResult.stderr}` : '') + (commandResult.timedOut ? '\n(test command timed out)' : ''),
    outcomes,
  }
  requireTestRuns(project).push(run)

  if (!skipStatusEvaluation) {
    evaluateRequirementStatus(project, run, false)
  }

  return run
}

// Re-evaluates the pass-threshold status flip against a specific TestRun's
// (or, for a regression pass, a specific TestRegressionRun's) already-
// recorded outcomes — safe to call multiple times for the same run as
// triage/confirmation state changes (e.g. once right after the run, again
// after a human confirms a test-case-failure verdict), since
// applyPassThreshold itself is a pure re-evaluation with no side effects
// beyond the requirement status it sets.
export function evaluateRequirementStatus(project: Project, run: TestRun, isFullRegressionPass: boolean) {
  const testCases = (project.testSuite?.tests ?? []).filter((t) => !t.deletedAt)
  return applyPassThreshold(project, testCases, run.outcomes, isFullRegressionPass)
}

export function evaluateRequirementStatusForRegression(project: Project, regressionRun: TestRegressionRun) {
  const runs = regressionRun.runIds.map((id) => (project.testRuns ?? []).find((r) => r.id === id)).filter((r): r is TestRun => !!r)
  const testCases = (project.testSuite?.tests ?? []).filter((t) => !t.deletedAt)
  return applyPassThreshold(project, testCases, runs.flatMap((r) => r.outcomes), true)
}

function requireRegressionRuns(project: Project): TestRegressionRun[] {
  if (!project.testRegressionRuns) project.testRegressionRuns = []
  return project.testRegressionRuns
}

// Full regression (Area F "Full regression policy", resolved) — not a
// separate artefact; the union of every element's own scoped run. Loops
// runElementTestSuite over every architecture element with active
// functional tests, and every connected pair with active integration
// tests, collects the resulting TestRun ids into one TestRegressionRun,
// and calls the pass-threshold flip exactly once over the COMBINED
// outcome set from every element-scoped run in this pass (so a
// requirement whose tests span two runs still needs all of them green in
// the same regression pass to flip to complete).
export async function runFullRegression(
  project: Project,
  projectDir: string,
  trigger: 'coding-success' | 'manual',
): Promise<TestRegressionRun> {
  const startedAt = new Date().toISOString()
  const suite = project.testSuite
  const activeCases = (suite?.tests ?? []).filter((t) => !t.deletedAt)

  const elementIds = new Set(
    activeCases.filter((t) => t.type === 'functional' && t.architectureElementId).map((t) => t.architectureElementId as string),
  )
  const interfacePairs = new Set(
    activeCases
      .filter((t) => t.type === 'integration' && t.interfaceElementIds)
      .map((t) => [...t.interfaceElementIds!].sort().join('|')),
  )

  const runs: TestRun[] = []
  for (const elementId of elementIds) {
    runs.push(await runElementTestSuite(project, projectDir, { architectureElementId: elementId }, true))
  }
  const connected = project.architecture ? connectedPairs(project.architecture.elements) : []
  for (const pair of connected) {
    const key = [pair.fromId, pair.toId].sort().join('|')
    if (!interfacePairs.has(key)) continue
    runs.push(await runElementTestSuite(project, projectDir, { interfaceElementIds: [pair.fromId, pair.toId] }, true))
  }

  const allOutcomes = runs.flatMap((r) => r.outcomes)

  const regressionRun: TestRegressionRun = {
    id: `REGRESSION-${startedAt}`,
    startedAt,
    finishedAt: new Date().toISOString(),
    runIds: runs.map((r) => r.id),
    allPassed: allOutcomes.every((o) => o.passed),
    trigger,
  }
  requireRegressionRuns(project).push(regressionRun)

  evaluateRequirementStatusForRegression(project, regressionRun)

  return regressionRun
}
