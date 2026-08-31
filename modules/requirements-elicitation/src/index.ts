export { SCHEMA_VERSION } from './types.js'
export type {
  Requirement,
  RequirementConflict,
  RequirementType,
  RequirementStatus,
  RequirementProvenance,
  Project,
  ProjectMode,
  QualityScore,
  QualityScoreDeduction,
  AnalystSeverity,
  ArchitectureTypeId,
  BuiltInPlatformId,
  PlatformId,
  PlatformDescriptor,
  Architecture,
  ArchitectureElement,
  ArchitectureElementKind,
  ArchitectureConflict,
  ArchitectureConflictKind,
  InterfaceRole,
  InterfaceDefinition,
  InterfaceElementDeclaration,
  ElementInterfaceDefinition,
  InterfaceContractOperation,
  IncompleteOperation,
  HarnessChecklistKey,
  HarnessChecklistStatus,
  HarnessChecklistItem,
  HarnessLinkRealisation,
  HarnessSpec,
  PhaseTabGating,
  ProjectSettings,
  ConflictCheckRecord,
  GapCheckRecord,
  ImportedCode,
  ImportedCodeFile,
  PendingImport,
  PendingImportRequirements,
  PendingImportRequirementsTagged,
  PendingImportArchitecture,
  PendingImportPreview,
  AlignmentStatus,
  CodeAlignmentMapping,
  CodeAlignmentRecord,
  RequirementCoverageStatus,
  ElementRequirementCoverage,
  ElementCodeCheck,
  MigrationAction,
  MigrationStory,
  MigrationPlanRecord,
  CodingRunStatus,
  CodingRun,
  UnitTestMode,
  TestType,
  TestCaseStatus,
  TestCase,
  TestSuite,
  ImportedTestCase,
  ImportedTestCaseSet,
  TestOutcomeTriage,
  TestCaseOutcome,
  SwTestOutcome,
  TestRunKind,
  TestRun,
  TestRegressionRun,
  ChatSurface,
  ChatMessageLink,
  ChatMessage,
  ChatSession,
} from './types.js'
export { ARCHITECTURE_TYPES, findArchitectureType } from './architectureTypes.js'
export type { ArchitectureTypeOption } from './architectureTypes.js'
export {
  BUILT_IN_PLATFORMS,
  DEFAULT_HARNESS_CHECKLIST,
  buildHarnessResponsibility,
  harnessRootWritePrefixesForPlatform,
  findPlatform,
  isBuiltInPlatformId,
  platformSlug,
} from './platforms.js'
export {
  setArchitectureType,
  createArchitectureElement,
  updateArchitectureElement,
  deleteArchitectureElement,
  pruneOrphanedInterfaceReferences,
  ensureHarnessElement,
  addLayer,
  removeLayer,
  checkArchitectureConflicts,
  autoConfigureAndAllocate,
  autoAllocateLlm,
  chatWithArchitect,
  acceptProposedInterface,
  removeArchitectureInterface,
  checkInterfaceConflict,
  defineInterfaceDefinition,
  defineAllInterfaceDefinitions,
  deriveHarnessSpec,
  setInterfaceDefinition,
  reconcileElementInterface,
  checkInterfaces,
  nextFreeColumn,
  EXTERNAL_CONTEXT_ROW,
  HARNESS_ROW,
  connectedPairs,
} from './architecture.js'
export type {
  CreateElementFields,
  UpdateElementFields,
  CheckArchitectureConflictsResult,
  AutoConfigureAndAllocateResult,
  AutoAllocateResult,
  ChatWithArchitectResult,
  ProposedArchitectureElement,
  ProposedInterface,
  CheckInterfaceConflictResult,
  DefineInterfaceDefinitionResult,
  DefineAllInterfaceDefinitionsResult,
  DeriveHarnessSpecResult,
  CheckInterfacesResult,
} from './architecture.js'
export {
  DEFAULT_PROJECT_SETTINGS,
  getProjectSettings,
  updateProjectSettings,
} from './projectSettings.js'
export { generateProjectOverview } from './projectOverview.js'
export type { GenerateProjectOverviewResult } from './projectOverview.js'
export { ProjectStore } from './store.js'
export type { ProjectStoreOptions } from './store.js'
export { computePhaseReadiness } from './phaseReadiness.js'
export type {
  PhaseReadiness,
  PhaseBlocker,
  PhaseStatus,
} from './phaseReadiness.js'
export type { LlmRole, LlmMessage, LlmClient, LlmCallOptions, LlmUsage, LlmChatResult } from './LlmClient.js'
export {
  DEFAULT_ANALYST_SYSTEM_PROMPT,
  ANALYSIS_SYSTEM_PROMPT,
  buildAnalystChatMessages,
  buildAnalysisPrompt,
  buildConflictCheckPrompt,
  buildGapCheckPrompt,
  buildSplitPrompt,
} from './analystPersona.js'
export {
  DEFAULT_ARCHITECT_SYSTEM_PROMPT,
  DEFINE_INTERFACE_CONTRACT_SYSTEM_PROMPT,
  DEFINE_HARNESS_SPEC_SYSTEM_PROMPT,
  buildArchitectChatMessages,
  buildHarnessSpecMessages,
} from './architecturePersona.js'
export {
  createTestCase,
  updateTestCase,
  deleteTestCase,
  generateFunctionalTestsForElement,
  generateIntegrationTestsForContract,
  generateAllTestsForUnplannedElements,
  chatWithQATestCreation,
} from './testCreation.js'
export type {
  CreateTestCaseFields,
  UpdateTestCaseFields,
  TraceabilityRejectionReason,
  CreateTestCaseResult,
  RejectedProposal,
  GenerateFunctionalTestsResult,
  GenerateIntegrationTestsResult,
  GenerateAllTestsResult,
  ProposedTest,
  ChatWithQATestCreationResult,
} from './testCreation.js'
export {
  FUNCTIONAL_TEST_PROPOSAL_SYSTEM_PROMPT,
  INTEGRATION_TEST_PROPOSAL_SYSTEM_PROMPT,
  buildFunctionalTestProposalMessages,
  buildIntegrationTestProposalMessages,
  DEFAULT_QA_TEST_CREATION_SYSTEM_PROMPT,
  buildTestCreationChatMessages,
} from './testCreationPersona.js'
export { importLegacyTestCases, deleteImportedTestCase } from './importTestCases.js'
export type { LegacyTestFile, ImportLegacyTestCasesResult } from './importTestCases.js'
export {
  IMPORTED_TEST_ANALYSIS_SYSTEM_PROMPT,
  buildImportedTestAnalysisMessages,
} from './importTestCasesPersona.js'
export {
  TEST_FAILURE_TRIAGE_SYSTEM_PROMPT,
  buildTriageMessages,
  buildUserReportedIssueTriageMessages,
  DEFAULT_QA_TEST_EXECUTION_SYSTEM_PROMPT,
  buildTestExecutionChatMessages,
  formatCodeContextForTriage,
  formatArchitectureForTriage,
} from './testExecutionPersona.js'
export { triageTestFailure, confirmTestCaseFailure, chatWithQATestExecution, classifyAndDispatchUserReportedIssue } from './testExecution.js'
export type { TriageTestFailureResult, ChatWithQATestExecutionResult, UserReportedIssueDispatch, ClassifyUserReportedIssueResult } from './testExecution.js'
export {
  CODE_GAP_SCAN_SYSTEM_PROMPT,
  DOCUMENT_IMPORT_SYSTEM_PROMPT,
  buildCodeGapScanPrompt,
  buildDocumentImportPrompt,
} from './reverseElicitationPersona.js'
export {
  proposeCodeGapRequirements,
  proposeCodeGapRequirementsPerFile,
  importDocumentsAsRequirements,
} from './codeImport.js'
export type {
  ImportedDocumentFile,
  CodeImportBundle,
  ProposeCodeGapRequirementsResult,
  ImportDocumentsResult,
} from './codeImport.js'
export { scoreCodeFilesForGapScan, filterCodeFilesForGapScan } from './codeOutline.js'
export type { CodeFileOutlineScore } from './codeOutline.js'
export { stripCodeFileContent, stripCodeFiles, DEFAULT_CODE_STRIP_OPTIONS } from './codeStrip.js'
export type { CodeStripOptions } from './codeStrip.js'
export { CODE_ALIGNMENT_SYSTEM_PROMPT, buildCodeAlignmentPrompt } from './codeAlignmentPersona.js'
export { runCodeAlignmentAnalysis } from './codeAlignment.js'
export { runElementCodeCheck } from './elementCodeCheck.js'
export type { RunElementCodeCheckResult } from './elementCodeCheck.js'
export { ELEMENT_CODE_CHECK_SYSTEM_PROMPT, buildElementCodeCheckPrompt } from './elementCodeCheckPersona.js'
export type { RunCodeAlignmentAnalysisResult } from './codeAlignment.js'
export {
  createRequirementFromForm,
  chatWithAnalyst,
  updateRequirementText,
  setAllocationRationale,
  analyseRequirements,
  importRequirementsFromText,
  countImportBlocks,
  checkConflicts,
  checkGaps,
  activeRequirements,
  deletedRequirements,
  deleteRequirement,
  restoreRequirement,
  purgeRequirement,
  reassignArchitectureElement,
  addRequirementToElement,
  removeRequirementFromElement,
  advanceStatusForward,
  regressStatusForRecode,
  setRequirementStatus,
  setCollapsedRequirementGroups,
  splitRequirement,
  findRequirementReferences,
  applySplitRequirement,
} from './elicitation.js'
export type {
  CreateRequirementFields,
  ChatWithAnalystResult,
  AnalyseResult,
  AnalyseRequirementsResult,
  ConflictPair,
  CheckConflictsResult,
  CheckGapsResult,
  ProposedSplitPiece,
  SplitRequirementResult,
  RequirementReferenceKind,
  RequirementReference,
  SplitPieceInput,
  ApplySplitRequirementResult,
} from './elicitation.js'
export { computeQualityScore, parseAnalystSeverity, parseAnalysisBlocks } from './qualityScore.js'
export {
  PROJECT_PARTS,
  exportPart,
  importRequirementsFromPart,
  importArchitecturePart,
} from './projectParts.js'
export type { ProjectPartId, ProjectPartInfo, RequirementsPartData, ArchitecturePartData } from './projectParts.js'
export {
  estimateTokensForText,
  contextLimitForModel,
  estimateAnalysisTokens,
  estimateCodeGapScanTokens,
} from './tokenEstimate.js'
export type {
  ModelContextLimit,
  TokenEstimate,
  CodeFileTokenEstimate,
  CodeGapScanTokenEstimate,
} from './tokenEstimate.js'
