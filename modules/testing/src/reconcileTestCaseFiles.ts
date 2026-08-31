import path from 'node:path'
import { existsSync } from 'node:fs'
import { isTestFilePath, sourceTreeRoot } from 'vic-coding'
import type { Project, TestCase } from 'vic-requirements-elicitation'

export type ReconcileReason = 'file-missing' | 'element-deleted' | 'not-a-test-file'

export interface ReconciledTestCase {
  testCaseId: string
  filePath?: string
  reason: ReconcileReason
}

export interface ReconcileTestCaseFilesResult {
  // Test cases whose stale filePath pointer was cleared (file gone from disk).
  cleared: ReconciledTestCase[]
  // Test cases soft-deleted because the architecture element they traced to
  // no longer exists.
  orphaned: ReconciledTestCase[]
  get changed(): boolean
}

// The single definition of "this test case's recorded filePath is not
// usable", and why. One rule, reused by runElementTestSuite's own per-scope
// heal. Returns undefined when the pointer is fine.
//
//   - 'not-a-test-file' : the path exists (or not) but its name doesn't
//     match the runnable "*.test.<ext>" pattern, so execution's discovery
//     would never find it. This is how Worm 2's TEST-003 got wedged with
//     filePath='_harness/index.html' — the file was present, so the old
//     existsSync-only check never freed it. Checked first: a wrong pointer
//     is wrong regardless of whether the wrong file happens to exist.
//   - 'file-missing'    : a valid test-file name that no longer resolves to
//     a real file (source tree re-coded, generated file lost).
export function testCaseFilePointerInvalid(
  testCase: TestCase,
  srcRoot: string,
): ReconcileReason | undefined {
  if (!testCase.filePath) return undefined
  if (!isTestFilePath(testCase.filePath)) return 'not-a-test-file'
  if (!existsSync(path.resolve(srcRoot, testCase.filePath))) return 'file-missing'
  return undefined
}

// Back-compat thin wrapper — some callers only care about the missing-file
// case. Prefer testCaseFilePointerInvalid for new code.
export function testCaseFileMissing(testCase: TestCase, srcRoot: string): boolean {
  return testCaseFilePointerInvalid(testCase, srcRoot) === 'file-missing'
}

// Reconcile every non-deleted test case against the current state of the
// source tree and architecture. Cheap (only existsSync + in-memory checks,
// no subprocess), idempotent, and safe to call after ANY mutation that can
// invalidate a test case's on-disk file or its owning element:
//
//   - a Coding run (success OR failure — a wipe-then-fail run still deletes
//     the old files), including a harness run that rewrites many folders
//   - a re-scaffold / recode-from-scratch
//   - deleting an architecture element
//   - test-file (re)generation
//
// Wiring it into all of those entry points is what makes the "stale
// filePath pointing at a deleted file" state (which silently broke Test
// Execution for the Worm Game) structurally unreachable through the UI,
// rather than only healed lazily the next time someone happens to run
// tests.
//
// Effects on a stale test case:
//   - file gone      -> filePath cleared, status reset to 'not-run',
//                       lastRunAt cleared  (shows as "not generated",
//                       regenerable)
//   - element gone   -> test case soft-deleted (deletedAt set), so it stops
//                       appearing in Test Creation / Test Execution
//
// Integration test cases (interfaceElementIds, no architectureElementId) are
// only checked for the missing-file case — their scope is a pair, not a
// single element, and pair folders are not removed by deleteArchitectureElement.
export function reconcileTestCaseFiles(project: Project, projectDir: string): ReconcileTestCaseFilesResult {
  const srcRoot = sourceTreeRoot(projectDir)
  const liveElementIds = new Set((project.architecture?.elements ?? []).map((e) => e.id))
  const cleared: ReconciledTestCase[] = []
  const orphaned: ReconciledTestCase[] = []

  for (const testCase of project.testSuite?.tests ?? []) {
    if (testCase.deletedAt) continue

    // Element deleted out from under a functional test case.
    if (testCase.architectureElementId && !liveElementIds.has(testCase.architectureElementId)) {
      testCase.deletedAt = new Date().toISOString()
      orphaned.push({ testCaseId: testCase.id, filePath: testCase.filePath, reason: 'element-deleted' })
      continue
    }

    // Recorded filePath is unusable — either not a runnable test-file name
    // (e.g. an .html the diff-order heuristic picked before T1.2), or a
    // valid name that no longer resolves on disk. Same heal either way: the
    // pointer was never (or is no longer) valid, so clear it and let the
    // test be regenerated.
    const invalidReason = testCaseFilePointerInvalid(testCase, srcRoot)
    if (invalidReason) {
      cleared.push({ testCaseId: testCase.id, filePath: testCase.filePath, reason: invalidReason })
      testCase.filePath = undefined
      testCase.status = 'not-run'
      testCase.lastRunAt = undefined
    }
  }

  return {
    cleared,
    orphaned,
    get changed() {
      return cleared.length > 0 || orphaned.length > 0
    },
  }
}
