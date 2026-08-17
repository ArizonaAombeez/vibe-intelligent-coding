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
export {
  buildCodingPrompt,
  runCodingForElement,
  isElementEligibleForCoding,
  requirementsAllocatedToElement,
} from './runCoding.js'
export type { RunCodingOptions } from './runCoding.js'
// Story-based Coding, kept only for the still-live /backlog/stories/:storyId/
// run-coding server route (hide-not-delete) — see legacyStoryCoding.ts's
// own header comment.
export {
  buildStoryCodingPrompt,
  runCodingForStory,
  isStoryEligibleForCoding,
  findStoriesSharingScope,
} from './legacyStoryCoding.js'
export type { CodingAgentClient } from './agentClient.js'
export { DEFAULT_DEV_SYSTEM_PROMPT, buildCodingChatMessages, formatElementContext } from './codingPersona.js'
export type { CodeContextFile } from './codingPersona.js'
export { chatWithDev } from './chatWithDev.js'
export type { ChatWithDevResult } from './chatWithDev.js'
export { scanCodeForRequirementReferences } from './codeReferenceScan.js'
export type { CodeReference } from './codeReferenceScan.js'
export { checkInterfaceCodeAlignment } from './interfaceCodeCheck.js'
export type {
  CheckInterfaceCodeAlignmentResult,
  UndocumentedOperation,
  UnimplementedOperation,
} from './interfaceCodeCheck.js'
