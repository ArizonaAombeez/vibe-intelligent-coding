import path from 'node:path'
import { readdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { elementSubfolderName, sourceTreeRoot } from 'vic-coding'
import { connectedPairs } from 'vic-requirements-elicitation'
import type { Project, TestCase, TestCaseOutcome, TestRegressionRun, TestRun, SwTestOutcome } from 'vic-requirements-elicitation'
import { resolveExecutionScope } from './executionScopeGate.js'
import { runTestCommand } from './testRunner.js'
import { applyPassThreshold } from './requirementStatusFlip.js'

function elementSubfolderById(project: Project): Map<string, string> {
  const map = new Map<string, string>()
  for (const element of project.architecture?.elements ?? []) {
    map.set(element.id, elementSubfolderName(element))
  }
  return map
}

// Interpreter derived purely from a test file's own extension — no stored
// per-element/per-file command needed. Each test file the coding agent (or
// Test Creation's own "Generate Test File") writes is a single,
// directly-runnable script by construction (see buildTestGenerationPrompt
// and runCoding's equivalent instruction for inline tests); running it is
// just re-invoking that same interpreter on that same file, exactly as it
// was run once already at generation/coding time. Extensions are the only
// ones actually observed in real generated projects so far — extend this
// map if a project introduces a new test language, not by resurrecting a
// stored RUN: command.
const INTERPRETER_BY_EXTENSION: Record<string, string> = {
  '.mjs': 'node',
  '.cjs': 'node',
  '.js': 'node',
  '.py': 'python',
}

const TEST_FILE_SUFFIX_PATTERN = /\.test\.[^./\\]+$/

// Recursively finds every "*.test.<ext>" file under an element's (or
// interface pair's) own scoped subfolder — an element's generated tests can
// live nested a level or two deep (e.g. <element>/<element>/foo.test.mjs,
// mirroring how vic-coding scaffolds each element's own package folder), so
// a single-level readdir would miss most of them.
async function findTestFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      files.push(...(await findTestFiles(full)))
    } else if (entry.isFile() && TEST_FILE_SUFFIX_PATTERN.test(entry.name)) {
      files.push(full)
    }
  }
  return files
}

interface TestFileResult {
  filePath: string // absolute
  passed: boolean
  output: string
}

// Runs every discovered test file in a scope as its own process (extension
// -> interpreter, see INTERPRETER_BY_EXTENSION) and returns one result per
// file. A file whose extension isn't recognized is skipped entirely (not
// reported as a failure) — there is nothing to run it with, and guessing
// would be worse than omitting it; see the caller for how an unrecognized
// file still shows up as "present but unrunnable" via rawLog.
async function runTestFiles(cwd: string, testFiles: string[]): Promise<{ results: TestFileResult[]; skipped: string[] }> {
  const results: TestFileResult[] = []
  const skipped: string[] = []
  for (const filePath of testFiles) {
    const ext = path.extname(filePath)
    const interpreter = INTERPRETER_BY_EXTENSION[ext]
    if (!interpreter) {
      skipped.push(filePath)
      continue
    }
    const relativeToScope = path.relative(cwd, filePath)
    const commandResult = await runTestCommand({ command: interpreter, args: [relativeToScope], cwd })
    const output =
      commandResult.stdout + (commandResult.stderr ? `\n${commandResult.stderr}` : '') + (commandResult.timedOut ? '\n(timed out)' : '')
    results.push({ filePath, passed: commandResult.exitCode === 0 && !commandResult.timedOut, output })
  }
  return { results, skipped }
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

// Path headers ("diff --git a/<path> b/<path>") from a Coding run's stored
// diff text — the only persisted record of exactly which files a Step 5
// coding run touched (CodingRun itself keeps the diff, not a separate file
// list). Used to recognize every file the coding agent wrote, regardless of
// whether it also happens to be linked to a Step 4 TestCase.
const DIFF_GIT_HEADER_PATTERN = /^diff --git a\/(.+) b\/(.+)$/gm

function pathsTouchedByDiff(diff: string): string[] {
  const paths = new Set<string>()
  for (const match of diff.matchAll(DIFF_GIT_HEADER_PATTERN)) {
    paths.add(match[2])
  }
  return [...paths]
}

// Every test file path (relative to srcRoot, forward-slash) written by a
// Step 5 Coding run for this scope — one architecture element's own
// successful CodingRuns, since Coding always runs against a single element
// (see runCoding.ts). An interface-pair scope has no CodingRun of its own,
// so it never contributes here.
//
// A Coding run's diff is captured from an isolated copy of just
// allowedSubfolder's own contents (see withIsolatedElementWorkspace in
// vic-coding: cp(srcRoot/allowedSubfolder, isolatedRoot, ...) makes
// allowedSubfolder's contents the isolated repo root) — so the diff's own
// paths are already exactly what runTestFiles/attributeResults see once
// re-anchored onto allowedSubfolder (matching the coding agent's own
// observed convention of nesting a same-named subfolder inside its scope,
// e.g. user-interface/user-interface/foo.test.mjs).
function stepFiveTestFilesForScope(project: Project, architectureElementId: string | undefined): Set<string> {
  const paths = new Set<string>()
  if (!architectureElementId) return paths
  for (const run of project.codingRuns ?? []) {
    if (run.architectureElementId !== architectureElementId || run.status !== 'success' || !run.diff) continue
    for (const p of pathsTouchedByDiff(run.diff)) {
      if (TEST_FILE_SUFFIX_PATTERN.test(p)) paths.add(`${run.allowedSubfolder}/${p}`)
    }
  }
  return paths
}

// Per-file outcome attribution: each discovered test file was already run
// on its own (runTestFiles above), so attribution is exact file-identity
// matching, not text parsing — no framework-specific pass/fail markup to
// guess at, since every file's own real exit code is already known. A
// result whose file matches a TestCase's filePath (relative to srcRoot) is
// that TestCase's requirement-traced outcome (shown in Test Execution's
// Test Creation column). Independently, a result whose file was written by
// a Step 5 Coding run (per stepFiveTestFilesForScope) is always also an
// SW-based (coding-agent) outcome (Area F "SW-based tests" / the Test
// Execution SW tests column) — the two are not mutually exclusive: a test
// case's own generated file can show up in both, since the reader wants to
// see every test file the coding agent produced regardless of whether it's
// also traced to a requirement.
function attributeResults(
  testCases: TestCase[],
  results: TestFileResult[],
  srcRoot: string,
  stepFiveTestFiles: Set<string>,
): { outcomes: TestCaseOutcome[]; swOutcomes: SwTestOutcome[] } {
  const testCaseByRelativePath = new Map(
    testCases.filter((t) => t.filePath).map((t) => [path.resolve(srcRoot, t.filePath!), t]),
  )

  const outcomes: TestCaseOutcome[] = []
  const swOutcomes: SwTestOutcome[] = []
  for (const result of results) {
    const relativePath = path.relative(srcRoot, result.filePath).split(path.sep).join('/')
    const testCase = testCaseByRelativePath.get(path.resolve(result.filePath))
    if (testCase) {
      outcomes.push({ testCaseId: testCase.id, passed: result.passed, output: result.output })
    }
    if (stepFiveTestFiles.has(relativePath) || !testCase) {
      swOutcomes.push({ name: path.basename(result.filePath), passed: result.passed })
    }
  }
  return { outcomes, swOutcomes }
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
// subprocess cost for a rejected scope" economy as Coding), discovers and
// runs every test file already written into that subfolder as its own
// process (see findTestFiles/runTestFiles — one real exit code per file,
// not a single shared command guessed at project-generation time),
// attributes each file's own outcome by matching its path against known
// TestCases (attributeResults), and persists a new TestRun onto
// project.testRuns.
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
      id: `TESTRUN-${startedAt}-${randomUUID()}`,
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
      swOutcomes: [],
    }
    requireTestRuns(project).push(run)
    return run
  }

  const testCases = activeTestsForScope(project.testSuite, scope.architectureElementId, scope.interfaceElementIds)
  const testFiles = await findTestFiles(resolved.cwd)
  const { results, skipped } = await runTestFiles(resolved.cwd, testFiles)

  const stepFiveTestFiles = stepFiveTestFilesForScope(project, scope.architectureElementId)
  const { outcomes, swOutcomes } = attributeResults(testCases, results, srcRoot, stepFiveTestFiles)
  for (const outcome of outcomes) {
    const testCase = testCases.find((t) => t.id === outcome.testCaseId)
    if (testCase) {
      testCase.status = outcome.passed ? 'passing' : 'failing'
      testCase.lastRunAt = new Date().toISOString()
    }
  }

  const allPassed = results.length > 0 && results.every((r) => r.passed)
  const rawLogSections = results.map((r) => `--- ${path.relative(srcRoot, r.filePath)} ---\n${r.output}`)
  if (skipped.length > 0) {
    rawLogSections.push(`(no interpreter known for: ${skipped.map((f) => path.relative(srcRoot, f)).join(', ')})`)
  }
  if (results.length === 0 && skipped.length === 0) {
    rawLogSections.push('No test files found in this scope.')
  }

  const run: TestRun = {
    id: `TESTRUN-${startedAt}-${randomUUID()}`,
    kind: 'element-scoped',
    architectureElementId: scope.architectureElementId ?? null,
    interfaceElementIds: scope.interfaceElementIds,
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: results.length === 0 ? null : allPassed ? 0 : 1,
    rawLog: rawLogSections.join('\n\n'),
    outcomes,
    swOutcomes,
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
// runElementTestSuite over every architecture element and every connected
// pair — not just ones with an active requirement-based TestCase, so an
// element whose only tests are the coding agent's own inline SW-based ones
// (Area F "SW-based tests") still gets swept and reported; a scope that was
// never scaffolded still resolves cheaply via runElementTestSuite's own
// rejected-scope short-circuit (no subprocess spawned). Collects the
// resulting TestRun ids into one TestRegressionRun, and calls the
// pass-threshold flip exactly once over the COMBINED requirement-traced
// outcome set from every element-scoped run in this pass (so a requirement
// whose tests span two runs still needs all of them green in the same
// regression pass to flip to complete) — SW outcomes never participate in
// that flip, since they have no requirement to satisfy.
export async function runFullRegression(
  project: Project,
  projectDir: string,
  trigger: 'coding-success' | 'manual',
): Promise<TestRegressionRun> {
  const startedAt = new Date().toISOString()

  const elementIds = (project.architecture?.elements ?? []).map((e) => e.id)
  const connected = project.architecture ? connectedPairs(project.architecture.elements) : []

  const runs: TestRun[] = []
  for (const elementId of elementIds) {
    runs.push(await runElementTestSuite(project, projectDir, { architectureElementId: elementId }, true))
  }
  for (const pair of connected) {
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
