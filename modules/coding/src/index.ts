export {
  elementSubfolderName,
  sharedInterfaceSubfolderName,
  scaffoldProjectSourceTree,
  sourceTreeRoot,
  wipeScopedSubfolder,
  SOURCE_TREE_DIRNAME,
  SHARED_INTERFACES_DIRNAME,
  MARKER_FILENAME,
} from './scaffold.js'
export type { ScaffoldResult } from './scaffold.js'
export { gitInitIfNeeded, gitStatusPorcelain, gitDiffText, gitCommitAll, gitRevertPaths } from './gitDiff.js'
export { resolveAllowedScope, enforceWriteScope } from './scopeGate.js'
export type { ResolvedScope, RejectedScope, ScopableEntity, EnforceWriteScopeResult } from './scopeGate.js'
export { withIsolatedElementWorkspace } from './isolatedWorkspace.js'
export type { IsolatedWorkspaceResult } from './isolatedWorkspace.js'
export {
  buildCodingPrompt,
  runCodingForElement,
  isElementEligibleForCoding,
  interfaceGateReasonForElement,
  interfaceChangedSinceLastCoding,
  requirementsAllocatedToElement,
  classifyCodingTaskReason,
} from './runCoding.js'
export type { RunCodingOptions, CodingTaskReason } from './runCoding.js'
export type { CodingAgentClient } from './agentClient.js'
export { scanCodeForRequirementReferences } from './codeReferenceScan.js'
export type { CodeReference } from './codeReferenceScan.js'
export { checkInterfaceCodeAlignment } from './interfaceCodeCheck.js'
export type {
  CheckInterfaceCodeAlignmentResult,
  UndocumentedOperation,
  UnimplementedOperation,
} from './interfaceCodeCheck.js'
