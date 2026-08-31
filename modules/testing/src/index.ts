export { generateTestFileForTestCase } from './writeTestFiles.js'
export type { GenerateTestFileStatus, GenerateTestFileResult } from './writeTestFiles.js'
export { buildTestGenerationPrompt } from './testGenerationPersona.js'
export { gatherTestSourceContext } from './testSourceContext.js'
export type { TestSourceContext, TestFileContext } from './testSourceContext.js'
export { runTestCommand } from './testRunner.js'
export type { RunTestCommandOptions, RunTestCommandResult } from './testRunner.js'
export { readElementTestCommand, writeElementTestCommand, DEFAULT_TEST_COMMAND } from './testCommandResolution.js'
export type { TestCommand } from './testCommandResolution.js'
export { resolveExecutionScope } from './executionScopeGate.js'
export type { ResolvedExecutionScope, RejectedExecutionScope } from './executionScopeGate.js'
export { applyPassThreshold } from './requirementStatusFlip.js'
export type { ApplyPassThresholdResult } from './requirementStatusFlip.js'
export {
  runElementTestSuite,
  runFullRegression,
  evaluateRequirementStatus,
  evaluateRequirementStatusForRegression,
} from './runExecution.js'
export type { RunElementTestSuiteScope } from './runExecution.js'
export { scopeReadinessEntries } from './scopeReadiness.js'
export type { ScopeReadiness, ScopeReadinessEntry } from './scopeReadiness.js'
export {
  reconcileTestCaseFiles,
  testCaseFileMissing,
  testCaseFilePointerInvalid,
} from './reconcileTestCaseFiles.js'
export type {
  ReconcileTestCaseFilesResult,
  ReconciledTestCase,
  ReconcileReason,
} from './reconcileTestCaseFiles.js'
// Re-exported from vic-coding so vic-testing's own callers have one import
// site for "what counts as a runnable test file" (T1.2).
export {
  TEST_FILE_SUFFIX_PATTERN,
  isTestFilePath,
  INTERPRETER_BY_EXTENSION,
  RUNNABLE_TEST_EXTENSIONS,
} from 'vic-coding'
