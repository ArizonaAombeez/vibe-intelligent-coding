export {
  elementSubfolderName,
  sharedInterfaceSubfolderName,
  scaffoldProjectSourceTree,
  sourceTreeRoot,
  wipeScopedSubfolder,
  SOURCE_TREE_DIRNAME,
  SHARED_INTERFACES_DIRNAME,
  HARNESS_SUBFOLDER_NAME,
  MARKER_FILENAME,
} from './scaffold.js'
export type { ScaffoldResult } from './scaffold.js'
export { gitInitIfNeeded, gitStatusPorcelain, gitDiffText, gitCommitAll, gitRevertPaths } from './gitDiff.js'
export { resolveAllowedScope, enforceWriteScope } from './scopeGate.js'
export type { ResolvedScope, RejectedScope, ScopableEntity, EnforceWriteScopeResult } from './scopeGate.js'
export { withIsolatedElementWorkspace, withHarnessWorkspace } from './isolatedWorkspace.js'
export type { IsolatedWorkspaceResult, HarnessWorkspaceResult } from './isolatedWorkspace.js'
export {
  buildCodingPrompt,
  runCodingForElement,
  isElementEligibleForCoding,
  interfaceGateReasonForElement,
  harnessGateReason,
  interfaceChangedSinceLastCoding,
  requirementsAllocatedToElement,
  classifyCodingTaskReason,
} from './runCoding.js'
export type { RunCodingOptions, CodingTaskReason } from './runCoding.js'
export type { CodingAgentClient } from './agentClient.js'
export { scanCodeForRequirementReferences } from './codeReferenceScan.js'
export type { CodeReference } from './codeReferenceScan.js'
export {
  TEST_FILE_SUFFIX_PATTERN,
  isTestFilePath,
  INTERPRETER_BY_EXTENSION,
  RUNNABLE_TEST_EXTENSIONS,
} from './testFilePattern.js'
export { checkInterfaceCodeAlignment } from './interfaceCodeCheck.js'
export type {
  CheckInterfaceCodeAlignmentResult,
  UndocumentedOperation,
  UnimplementedOperation,
} from './interfaceCodeCheck.js'
export {
  parseElementExports,
  scanElementApi,
  scanElementApis,
} from './elementApiScan.js'
export type { ElementApi, ElementExport } from './elementApiScan.js'
