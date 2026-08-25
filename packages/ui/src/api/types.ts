// UI-facing core API contract (Area G — "UI as a pluggable module").
// This is the boundary the reference UI consumes. Any real core module
// (or a future alternative UI) implements/consumes this same contract —
// see VicCoreApi below.

export type Status = 'not-started' | 'in-progress' | 'blocked' | 'complete'

export type PhaseId =
  | 'dashboard'
  | 'requirements'
  | 'architecture'
  | 'test-creation'
  | 'coding'
  | 'test-execution'

// Import/Export (Area G) works over the same phases as PhaseId, minus
// 'dashboard' (not a real project part) — kept as its own type since the
// Import/Export checkbox list is the only place that needs to know which
// phases currently have exportable data.
export type ProjectPartId = Exclude<PhaseId, 'dashboard'>

export interface ProjectPartInfo {
  id: ProjectPartId
  label: string
  // False for phases with no backing data to export/import yet — the
  // Import/Export dialog shows these but disables their checkbox.
  available: boolean
}

export interface SubstepInfo {
  id: string
  label: string
  status: Status
}

export interface PhaseInfo {
  id: PhaseId
  label: string
  status: Status
  substeps: SubstepInfo[]
}

export interface ProjectSummary {
  id: string
  name: string
  lastOpenedAt: string
}

// Name-only login (no password) — see packages/server/src/usersStore.ts.
// Identity/attribution only, not a security boundary: any known user id can
// be sent from the client, the server doesn't verify it belongs to the
// person using it. isAdmin gates the Settings > Plugins/Personas tabs
// client-side only — a non-admin who edited request payloads directly
// could still hit those routes, same as every other unenforced boundary in
// this no-auth trust model.
export interface VicUser {
  id: string
  name: string
  createdAt: string
  isAdmin: boolean
}

export interface ProjectSettings {
  earsMode: 'full' | 'lite'
  unitTestMode: 'llm' | 'scaffold' | 'disabled'
  lightDarkMode: 'light' | 'dark' | 'system'
  autoSave: boolean
  phaseTabGating: 'gated' | 'always-accessible'
}

export interface CurrentOperation {
  text: string | null
  error?: string
  // Set when `error` is specifically "no LLM provider configured" (server
  // code 'llm-not-configured') — the UI shows an "Open Settings" action
  // instead of Retry, since retrying an unconfigured provider can only fail
  // identically again. 'project-run-locked' (server code of the same name)
  // means another Coding run already holds this project's lock (see
  // acquireProjectRunLock) — retrying immediately would just be rejected
  // again, so the UI should suggest waiting instead.
  errorCode?: 'llm-not-configured' | 'project-run-locked'
}

// Running total across the session, accumulated over every LLM-backed call.
// The mock API synthesizes a small fixed estimate per call so the figure is
// visibly non-zero during UI dev; a real server supplies actual usage from
// the LLM provider's API response through the same shape.
export interface TokenUsage {
  totalTokens: number
  estimatedCostUsd: number
}

// Mirrors modules/requirements-elicitation/src/types.ts's ProjectMode — set
// at project creation and never changed afterwards, per the
// UI-as-a-pluggable-module principle (kept as a plain literal here rather
// than importing the core module).
export type ProjectMode = 'new' | 'import'

export interface OpenProjectResult {
  projectId: string
  projectName: string
  phases: PhaseInfo[]
  settings: ProjectSettings
  // Null until the Architect selects one at the top of the Architecture tab
  // (Area B, "Architecture type selection").
  architectureType: ArchitectureTypeId | null
  projectMode: ProjectMode
  // Set once the project's codebase zip has been uploaded via Import
  // Project (REQ-055) — undefined for 'new' mode projects, and for
  // 'import' mode projects that haven't uploaded yet.
  importedCode?: { codeFileCount: number; documentFileCount: number; importedAt: string }
  // Most recent code alignment analysis (REQ-059/060), if any has run yet.
  codeAlignment?: CodeAlignmentRecord
  // Most recent migration plan (REQ-061), if any has been generated yet.
  migrationPlan?: MigrationPlanRecord
}

// Preset Architecture types (Area B, resolved) — each sets default grid
// layer rows and the dynamic-design default when the grid is first
// generated. 'custom' has no preset layers.
export type ArchitectureTypeId =
  | 'web-app'
  | 'desktop'
  | 'mobile'
  | 'networking'
  | 'embedded'
  | 'cli-library'
  | 'backend-service'
  | 'data-pipeline'
  | 'microservices'
  | 'game-realtime'
  | 'custom'

export interface ArchitectureTypeOption {
  id: ArchitectureTypeId
  label: string
  description: string
  defaultLayers: string[]
  dynamicDesignDefault: boolean
}

// Grid-based architecture structure (Area B, resolved) — mirrors
// modules/requirements-elicitation/src/types.ts's Architecture/
// ArchitectureElement, kept as a plain type here rather than importing the
// core module, per the UI-as-a-pluggable-module principle.
export type ArchitectureElementKind = 'functional' | 'interface-spine' | 'service' | 'external' | 'runtime'

export interface ArchitectureElement {
  id: string
  kind: ArchitectureElementKind
  name: string
  responsibility: string
  row: number
  col: number
  rowSpan: number
  colSpan: number
  interfaces: string[]
  elementInterfaces: ElementInterfaceDefinition[]
  dynamicDesignEnabled?: boolean
}

export type ArchitectureConflictKind =
  | 'interface-mismatch'
  | 'overlapping-responsibility'
  | 'circular-dependency'

export interface ArchitectureConflict {
  id: string
  kind: ArchitectureConflictKind
  elementIds: string[]
  rationale: string
}

export interface InterfaceContractOperation {
  name: string
  description: string
  request: string
  response: string
  errors: string
  range?: string
  resolution?: string
  unit?: string
  updateFrequency?: string
  drivenDirectly?: boolean
}

export type InterfaceRole = 'produces' | 'consumes' | 'both'

// Project-wide master interface definition (Area B, resolved) — the single
// source of truth every participant element's own ElementInterfaceDefinition
// copy is checked against. Replaces the old pairwise InterfaceContract:
// participants.length can be > 2, so one definition can represent a shared
// bus/topic's whole fan-out/fan-in, not just one edge.
export interface InterfaceDefinition {
  id: string
  name: string
  participants: Array<{ elementId: string; role: InterfaceRole }>
  operations: InterfaceContractOperation[]
  status: 'defined' | 'stale'
  updatedAt: string
}

// One element's own local copy of an interface it participates in — lives
// on ArchitectureElement.elementInterfaces. aligned:false is a hard block
// on Coding (see interfaceGateReasonForElement) until a human reconciles
// this element's copy against the master (PUT .../interfaces/:id/reconcile).
export interface ElementInterfaceDefinition {
  masterDefinitionId: string
  role: InterfaceRole
  operations: InterfaceContractOperation[]
  aligned: boolean
  reqsCheckedAt?: string
}

export interface Architecture {
  layers: string[]
  elements: ArchitectureElement[]
  nextElementSeq: number
  nextInterfaceSeq: number
  conflicts?: ArchitectureConflict[]
  interfaceDefinitions?: InterfaceDefinition[]
}

export interface IncompleteOperation {
  fromId: string
  toId: string
  operationName: string
  missingFields: string[]
}

export interface CheckInterfacesResult {
  undefinedPairs: Array<{ fromId: string; toId: string }>
  staleContracts: InterfaceDefinition[]
  incompleteOperations: IncompleteOperation[]
  misalignedElements: Array<{ elementId: string; masterDefinitionId: string }>
  // An element's own interface copy pointing at a masterDefinitionId that
  // no longer exists — a broken reference, not merely out of date. See
  // architecture.ts's own comment on this field for how this can happen
  // (historical projects that generated an "IFACE-undefined" id before a
  // counter-init bug was fixed).
  danglingElementInterfaces: Array<{ elementId: string; masterDefinitionId: string }>
  complete: boolean
}

// One contract operation, or one code-declared identifier, that couldn't
// be matched to its counterpart on a given interface pair.
export interface InterfaceCodeMismatch {
  fromId: string
  toId: string
  operationName: string
}

export interface CheckInterfaceCodeAlignmentResult {
  // Contract operations with no matching code found for that pair — the
  // Architecture defines it, code doesn't appear to implement it yet.
  unimplementedOperations: InterfaceCodeMismatch[]
  // Declared functions/methods in that pair's code with no matching
  // contract operation — code that may implement an interface the
  // Architecture never defined. Best-effort text scan, reported for a
  // human to judge, never auto-removed.
  undocumentedIdentifiers: InterfaceCodeMismatch[]
  aligned: boolean
}

// Reserved row for external/context elements — rendered outside the main
// layer grid (see ArchitectureGrid.tsx), mirrors the core module's
// EXTERNAL_CONTEXT_ROW constant (kept as a plain literal here rather than
// importing the core module, per the UI-as-a-pluggable-module principle).
export const EXTERNAL_CONTEXT_ROW = -1

export interface AutoConfigureAndAllocateResult {
  architecture: Architecture
  createdElements: ArchitectureElement[]
  allocatedRequirementIds: string[]
  unallocatedRequirementIds: string[]
}

export interface AutoAllocateResult {
  architecture: Architecture
  allocatedRequirementIds: string[]
  unallocatedRequirementIds: string[]
}

export interface CreateArchitectureElementFields {
  kind: ArchitectureElementKind
  name: string
  responsibility: string
  row: number
  col: number
  rowSpan?: number
  colSpan?: number
  interfaces?: string[]
}

export interface UpdateArchitectureElementFields {
  name?: string
  responsibility?: string
  row?: number
  col?: number
  rowSpan?: number
  colSpan?: number
  interfaces?: string[]
  dynamicDesignEnabled?: boolean
}

export interface ProposedArchitectureElement {
  kind: ArchitectureElementKind
  name: string
  layer: string
  responsibility: string
}

export interface ProposedInterface {
  from: string
  to: string
}

export interface ArchitectChatResult {
  reply: string
  proposedElements: ProposedArchitectureElement[]
  proposedInterfaces: ProposedInterface[]
}

// Coding & Review-Rework (Area D, resolved) — mirrors
// modules/requirements-elicitation/src/types.ts's CodingRun, kept as a
// plain type here per the UI-as-a-pluggable-module principle.
export type CodingRunStatus = 'success' | 'rejected-scope' | 'rejected-multi-element' | 'rejected-not-eligible' | 'rejected-empty-output' | 'cli-error'

export interface CodingRun {
  id: string
  architectureElementId: string
  startedAt: string
  finishedAt: string
  status: CodingRunStatus
  diff: string
  rawLog: string
  exitCode: number | null
  allowedSubfolder: string
  rejectedFiles?: string[]
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
  // Which agent client/provider actually ran this (e.g. 'claude-code',
  // 'opencode') and which model was requested — undefined only for runs
  // that never reached the point of invoking an agent client at all
  // (rejected-not-eligible). Lets the Coding screen show which provider a
  // given run's timing belongs to, so a slow run can be attributed to a
  // specific provider/model rather than left ambiguous.
  providerId?: string
  model?: string
  // Provider-agnostic timing breakdown, derived purely from process
  // lifecycle events (spawn/first output/exit) — works identically
  // regardless of which provider ran. msToFirstOutput is the "how long
  // before anything at all happened" signal that distinguishes a slow
  // provider start from genuinely long agent work.
  timing?: {
    msToFirstOutput?: number
    msTotal: number
  }
}

// "Analyse Code" (Area D) — mirrors
// modules/requirements-elicitation/src/types.ts's ElementRequirementCoverage.
export type RequirementCoverageStatus = 'satisfied' | 'partial' | 'not-satisfied'

export interface ElementRequirementCoverage {
  requirementId: string
  status: RequirementCoverageStatus
  rationale: string
}

// Test Creation & Execution (Areas E/F, resolved) — mirrors
// modules/requirements-elicitation/src/types.ts's TestCase/TestSuite/
// TestRun/TestRegressionRun, kept as plain types here per the
// UI-as-a-pluggable-module principle.
export type TestType = 'functional' | 'integration'
export type TestCaseStatus = 'not-run' | 'passing' | 'failing'

export interface TestCase {
  id: string
  type: TestType
  title: string
  requirementIds: string[]
  interfaceDefinitionId?: string
  architectureElementId: string | null
  interfaceElementIds?: [string, string]
  filePath?: string
  status: TestCaseStatus
  lastRunAt?: string
  createdAt: string
  deletedAt?: string
}

export interface TestSuite {
  tests: TestCase[]
  nextTestSeq: number
}

// Legacy test cases imported from an existing (non-VIC) folder — kept
// separate from TestCase/TestSuite since these are untraced (no requirement
// or interface contract link) and never pass through the traceability
// gate. See vic-requirements-elicitation's ImportedTestCase for the full
// rationale.
export interface ImportedTestCase {
  id: string
  sourceRelativePath: string
  title: string
  description: string
  filePath: string
  importedAt: string
}

export interface ImportedTestCaseSet {
  tests: ImportedTestCase[]
  nextImportedTestSeq: number
}

export type TraceabilityRejectionReason =
  | 'no-requirement-ids'
  | 'requirement-not-found'
  | 'requirement-not-allocated-to-element'
  | 'no-contract-ref'
  | 'contract-not-found'
  | 'contract-not-defined'

export interface CreateTestCaseFields {
  type: TestType
  title: string
  requirementIds?: string[]
  interfaceDefinitionId?: string
  architectureElementId?: string | null
  interfaceElementIds?: [string, string]
}

export interface UpdateTestCaseFields {
  title?: string
  status?: TestCaseStatus
  filePath?: string
  lastRunAt?: string
}

export interface RejectedProposal {
  title: string
  reason: TraceabilityRejectionReason
}

export interface ProposedTest {
  title: string
  requirementIds: string[]
}

export interface TestCreationChatResult {
  reply: string
  proposedTests: ProposedTest[]
}

// A user-described issue's dispatch outcome (Area F "User-reported issue
// triage", resolved) — set only when a test/run is in focus and the QA
// persona was able to classify the message; undefined for an ordinary
// conversational reply (no test in focus, or the message didn't read as an
// issue report). code-failure/requirement-issue are auto-dispatched by the
// time this result is returned; test-case-failure is a proposal only,
// mirroring the existing mandatory-human-confirmation gate.
export interface TestExecutionChatDispatch {
  verdict: 'code-failure' | 'test-case-failure' | 'requirement-issue'
  rationale: string
  // Which id the verdict was dispatched against — architectureElementId for
  // code-failure, requirementId for requirement-issue. Undefined for
  // test-case-failure (nothing is dispatched yet, pending confirmation).
  dispatchedTo?: string
}

export interface TestExecutionChatResult {
  reply: string
  dispatch?: TestExecutionChatDispatch
}

export type TestOutcomeTriage = 'code-failure' | 'test-case-failure' | 'requirement-issue' | 'unattributed'

export interface TestCaseOutcome {
  testCaseId: string
  passed: boolean
  output: string
  triage?: TestOutcomeTriage
  triageRationale?: string
  testCaseFailureConfirmedAt?: string
}

// A test result from a scope's test command that didn't match any known
// (requirement-traced) TestCase title — the coding agent's own inline tests
// written while implementing the element, never registered via Test
// Creation. No TestCase id to attach to, so identified by name only.
export interface SwTestOutcome {
  name: string
  passed: boolean
}

export type TestRunKind = 'element-scoped' | 'full-regression'

export interface TestRun {
  id: string
  kind: TestRunKind
  architectureElementId?: string | null
  interfaceElementIds?: [string, string]
  startedAt: string
  finishedAt: string
  exitCode: number | null
  rawLog: string
  outcomes: TestCaseOutcome[]
  // Present (possibly empty) once this scope's test titles could be parsed
  // out of the command output at all; undefined for runs that predate this
  // field or whose output couldn't be parsed per-test.
  swOutcomes?: SwTestOutcome[]
  mutationScore?: { killed: number; survived: number; percentage: number }
}

export interface TestRegressionRun {
  id: string
  startedAt: string
  finishedAt: string
  runIds: string[]
  allPassed: boolean
  trigger: 'coding-success' | 'manual'
}

export type TestCommandScope = { architectureElementId: string } | { interfaceElementIds: [string, string] }

export type ScopeReadiness =
  | { ready: true }
  | { ready: false; reason: 'element-not-coded' | 'interface-element-not-coded' }

export interface ScopeReadinessEntry {
  scopeKey: string
  readiness: ScopeReadiness
}

// Six requirement types (Area A, resolved) — assigned upon allocation, so
// null until an architecture allocation exists.
export type RequirementType =
  | 'functional'
  | 'interface-comms'
  | 'data'
  | 'non-functional'
  | 'constraint'
  | 'scheduling'

export type RequirementStatus =
  | 'elicited'
  | 'architected'
  | 'allocated'
  | 'coded'
  | 'tested'
  | 'tested-fail'
  | 'complete'

export interface QualityScoreDeduction {
  rule: string
  description: string
  amount: number
}

export type AnalystSeverity = 'good' | 'fair' | 'poor'

// 1-5 quality score. The text/conflict deductions are computed locally
// (INCOSE Guide for Writing Requirements-derived heuristics);
// analystSeverity/analystPenalty are only present after an "Analyse"
// action has run, layering the LLM's own judgement on top. Advisory
// only — surfaces weak requirements, never blocks progression.
export interface QualityScore {
  score: number
  deductions: QualityScoreDeduction[]
  conflictPenalty: number
  analystSeverity?: AnalystSeverity
  analystPenalty?: number
}

// One other requirement this one conflicts with, with the rationale text
// (not just the id) so the requirement's own detail view can show the
// actual finding, not just an id the user has to go look up elsewhere.
export interface RequirementConflict {
  requirementId: string
  rationale: string
}

export interface Requirement {
  id: string
  text: string
  type: RequirementType | null
  status: RequirementStatus
  createdAt: string
  // Latest per-requirement Analyst review reply (from an explicit
  // "Analyse" action). Undefined means Review Clarity has never run for
  // this requirement — the detail panel shows "Not Run Yet" rather than
  // hiding the section.
  analystNote?: string
  // Undefined until Review Clarity or Check Conflicts has run at least
  // once for this requirement.
  qualityScore?: QualityScore
  // Every other active requirement this one is flagged as conflicting with
  // (from the most recent Check Conflicts run), unresolved. Empty array
  // (not undefined) once Check Conflicts has run and found nothing for
  // this requirement — see conflictsCheckedAt for "never run".
  conflicts?: RequirementConflict[]
  // Set every time Check Conflicts runs for this requirement, even when
  // clean — the only way to distinguish "never checked" (absent, detail
  // panel shows "Not Run Yet") from "checked, none found" (set, conflicts
  // empty, detail panel shows "None found").
  conflictsCheckedAt?: string
  // Architecture element(s)/block(s) this requirement has been allocated to
  // (Area B). Always an array, never undefined — empty means unallocated,
  // and falls under "Unallocated to Architecture" in the Requirements
  // list's grouping. A requirement allocated to 2+ elements appears once
  // per element it belongs to in that grouped list.
  architectureElements: string[]
  // Free-text hint the user can attach to steer Auto Allocate (LLM) toward
  // the right architecture element. Undefined until set.
  allocationRationale?: string
  // Set when the requirement has been soft-deleted (moved to the Bin).
  // Deleted requirements are excluded from listRequirements and only
  // returned by listDeletedRequirements.
  deletedAt?: string
}

export interface AnalyseResult {
  requirementId: string
  note: string
  qualityScore: QualityScore
}

// Split Requirement (Requirements screen) — one proposed replacement piece
// from the Analyst, before it becomes a real requirement. moduleName is a
// best-guess architecture element *name* (the panel resolves it to a real
// element id for display/editing); undefined means the Analyst didn't guess.
export interface ProposedSplitPiece {
  text: string
  moduleName?: string
}

export interface SplitRequirementResult {
  pieces: ProposedSplitPiece[]
}

export type RequirementReferenceKind =
  | 'conflict'
  | 'test-case'
  | 'analyst-note-mention'
  | 'conflict-rationale-mention'
  | 'test-case-title-mention'

export interface RequirementReference {
  kind: RequirementReferenceKind
  label: string
}

// A stray "REQ-NNN" text mention found in the project's generated source
// tree (e.g. a comment) — never a structural link, so it's reported but
// never auto-rewritten. See RequirementReference for the structural half.
export interface CodeReference {
  relativePath: string
  lines: number[]
}

export interface RequirementReferencesResult {
  structuralReferences: RequirementReference[]
  codeReferences: CodeReference[]
}

export interface SplitPieceInput {
  text: string
  architectureElementId: string | null
}

export interface ApplySplitRequirementResult {
  createdRequirements: Requirement[]
  updatedTestCaseIds: string[]
}

// Pre-flight, non-billed estimate for a Review Clarity run (see the
// requirements-elicitation module's tokenEstimate.ts) — char-count
// heuristic, not an exact figure. warnAt/contextWindow reflect whichever
// model the Analyst persona currently resolves to.
export interface TokenEstimate {
  inputTokens: number
  estimatedOutputTokens: number
  totalTokens: number
  contextWindow: number
  warnAt: number
  nearContextLimit: boolean
}

export interface ConflictPair {
  requirementIds: [string, string]
  rationale: string
}

export interface CheckConflictsResult {
  pairs: ConflictPair[]
  requirements: Requirement[]
}

export interface GapCheckRecord {
  suggestions: string[]
  checkedAt: string
}

export interface ConflictCheckRecord {
  pairs: ConflictPair[]
  checkedAt: string
}

// The last Check Conflicts / Check Gaps run for a project, if any — lets
// the Requirements screen redisplay the results panel after navigating
// away and back, instead of that panel only existing as transient UI
// state that's lost on navigation.
export interface LastChecksResult {
  lastConflictCheck: ConflictCheckRecord | null
  lastGapCheck: GapCheckRecord | null
}

export interface AnalystChatResult {
  reply: string
  proposedRequirements: string[]
}

// Mirrors modules/requirements-elicitation/src/types.ts's provenance union
// for a Requirement — which mechanism produced it. 'human' is the default
// for everything created via the normal form/chat/gap-check flows already
// in the UI; the other two only appear for 'import' mode projects.
export type RequirementProvenance = 'human' | 'imported-document' | 'reverse-elicited-code'

// Import Project (REQ-055) — points VIC at up to three independent
// server-side locations (code, requirements, architecture may each live
// somewhere different; no browser API exists for picking an arbitrary
// server-side path, so these are typed paths on the machine running the
// server, not file uploads). previewImportProject computes what importing
// them would produce WITHOUT committing anything; only saveImportProject
// actually creates the requirements/architecture elements. Every option is
// a deterministic, non-LLM parse of an exact expected format — never an
// LLM call. Reverse-elicitation-style proposals only happen later, via the
// explicitly user-triggered scanCodeGaps action.
export interface ImportProjectPreviewOptions {
  codePath: string | null
  requirementsPath: string | null
  // 'vic-export' expects requirementsPath to point directly at a
  // requirements.json (same format/merge behaviour as Import/Export's
  // existing part-import). 'vic-tagged' accepts either a single file or a
  // folder to scan for VIC's tagged block format (REQ_001 ...
  // ##END_OF_REQ) and imports any that match. Required (non-null) exactly
  // when requirementsPath is set.
  requirementsFormat: 'vic-export' | 'vic-tagged' | null
  // Expected to point directly at a previously-exported architecture.json.
  architecturePath: string | null
}

export interface ImportProjectPreview {
  codeFileCount: number
  requirementsImportedCount: number
  architectureImportedCount: number
}

// Result of POST /scan-code-gaps (Import Project, REQ-056) — proposals only,
// scoped against the project's confirmed requirements at the time the scan
// ran (behaviour already covered by an existing requirement is not
// re-proposed). Re-runnable at any point after a codebase has been
// imported via saveImportProject.
export interface ScanCodeGapsResult {
  proposedRequirements: string[]
}

// Per-file entry in a code gap scan token estimate (see
// GET /scan-code-gaps/estimate). tokens is a rough char-count-based
// estimate (see server tokenEstimate.ts), not an exact provider count.
export interface CodeFileTokenEstimate {
  path: string
  tokens: number
}

// Independent content-shrinking toggles applied to a file's content before
// a gap scan — see modules/requirements-elicitation/src/codeStrip.ts for
// the full tradeoff behind each one. stripBlankLines is pure formatting
// noise (safe, on by default); stripComments and stripBodies trade real
// requirement-finding accuracy for bigger token savings, so both default
// off and are opt-in.
export interface CodeStripOptions {
  stripBlankLines: boolean
  stripComments: boolean
  stripBodies: boolean
}

export const DEFAULT_CODE_STRIP_OPTIONS: CodeStripOptions = {
  stripBlankLines: true,
  stripComments: false,
  stripBodies: false,
}

// One content mode's worth of sizing — see server CodeGapScanContentEstimate.
export interface CodeGapScanContentEstimate {
  files: CodeFileTokenEstimate[]
  fixedOverheadTokens: number
  singleCallTotalTokens: number
  perFileTotalTokens: number
  perFileCallCount: number
  singleCallFits: boolean
}

// Pre-flight, non-LLM estimate of a code gap scan's size, covering both
// independent axes the dialog offers: content ('complete' vs 'stripped',
// per whatever CodeStripOptions the dialog requested) and delivery
// ('single-call' vs 'per-file', within each content estimate) — so the UI
// can show all four combinations without a round trip per toggle change.
// model is the persona's actually-resolved model (Settings > Personas
// override, else the plugin's configured/default model) — undefined only
// if no LLM provider is configured for this persona at all, in which case
// contextWindow/warnAt are a conservative generic fallback, not a specific
// model's real window.
export interface CodeGapScanTokenEstimate {
  complete: CodeGapScanContentEstimate
  stripped: CodeGapScanContentEstimate
  contextWindow: number
  warnAt: number
  model?: string
}

// content: 'complete' sends each file's original content; 'stripped'
// applies stripOptions first (required when content is 'stripped'). mode:
// 'single-call' concatenates every file into one LLM call (can exceed the
// model's context window on a large import — see
// CodeGapScanContentEstimate.singleCallFits). 'per-file' runs one call per
// file instead (no such ceiling, more calls, loses cross-file context).
// maxFiles ('per-file' only) applies the structure-only pre-filter
// server-side to cap how many files/calls run.
export interface ScanCodeGapsOptions {
  content: 'complete' | 'stripped'
  mode: 'single-call' | 'per-file'
  stripOptions?: CodeStripOptions
  maxFiles?: number
}

// Mirrors modules/requirements-elicitation/src/types.ts's AlignmentStatus/
// CodeAlignmentMapping/CodeAlignmentRecord (Import Project, REQ-059/060).
// architectureElementId is null when a file couldn't be mapped to any
// architecture element — a flag for human review, not a reason to drop it.
export type AlignmentStatus = 'aligned' | 'partially-aligned' | 'no-equivalent'

export interface CodeAlignmentMapping {
  filePath: string
  architectureElementId: string | null
  status: AlignmentStatus | null
  rationale: string
}

export interface CodeAlignmentRecord {
  mappings: CodeAlignmentMapping[]
  checkedAt: string
}

// Mirrors modules/requirements-elicitation/src/types.ts's MigrationAction/
// MigrationStory/MigrationPlanRecord (Import Project, REQ-061) — one story
// per architecture element, action derived from that element's alignment
// status.
export type MigrationAction = 'reuse-as-is' | 'refactor-in-place' | 'rewrite'

export interface MigrationStory {
  id: string
  architectureElementId: string
  action: MigrationAction
  rationale: string
  createdAt: string
}

export interface MigrationPlanRecord {
  stories: MigrationStory[]
  generatedAt: string
}

export interface PluginSettingOption {
  value: string
  label: string
}

// Generic plugin-settings shape, mirrored from each plugin module's own
// settingsManifest (e.g. vic-llm-glm). The UI never hardcodes a specific
// plugin's fields — it renders whatever the server reports here. 'select'
// fields (e.g. GLM's model/thinking choice) come with a curated `options`
// list — providers like z.ai have no API to fetch valid choices live, so
// these are shipped by the plugin and rendered as a dropdown, not free text.
export interface PluginSettingField {
  key: string
  label: string
  description: string
  secret: boolean
  type: 'text' | 'select'
  options?: PluginSettingOption[]
  hasValue: boolean
  value?: string
}

export interface PluginSettings {
  id: string
  label: string
  // What this plugin needs to work (e.g. "cloud API only, nothing to
  // install" vs. "requires the Foo CLI on PATH") and, if relevant, where
  // to obtain credentials for it. Every plugin in the library fills these
  // in generically — the Settings screen never hardcodes plugin-specific
  // setup instructions.
  setupSummary: string
  setupUrl?: string
  fields: PluginSettingField[]
  // True for plugins backed by a local CLI (e.g. Claude Code) rather than a
  // cloud API — the Settings screen offers a "Check installation" action
  // for these, calling checkPluginStatus below.
  cliCheckable?: boolean
}

// Result of checkPluginStatus for a CLI-backed plugin. Deliberately not
// fetched automatically on Settings load — checking is a local subprocess
// call the user triggers explicitly, so it's obvious the app isn't doing
// unexpected background work with an installed CLI.
export interface PluginInstallStatus {
  installed: boolean
  version?: string
  error?: string
}

// One rolling rate-limit/quota window (e.g. Claude Code's Pro/Max plan
// 5-hour or weekly window, GLM's Coding Plan 5-hour or weekly token
// window). percentUsed is provider-reported, not derived from VIC's own
// token counting — distinct from TokenUsage above, which is a running
// total VIC itself tallies from LLM call responses.
export interface UsageWindow {
  percentUsed: number
  resetsAt?: string
}

// Result of getPluginUsage for whichever plugin currently backs a
// persona. Either window may be absent — a plugin might expose only one,
// or (getPluginUsage rejects with a 501) none at all, in which case the
// caller treats the whole lookup as unavailable rather than getting an
// empty object back.
export interface PluginUsage {
  currentWindow?: UsageWindow
  weekly?: UsageWindow
}

// A persona-level override of a subset of its backing plugin's settings
// (e.g. the Analyst using a cheaper/faster model than the GLM plugin's
// global default). `fields` only ever contains the plugin's declared
// personaOverridableFields — never a secret.
export interface PersonaOverrideField {
  key: string
  label: string
  description: string
  type: 'text' | 'select'
  options?: PluginSettingOption[]
  value: string
}

// One entry per installed LLM plugin, for populating a persona's plugin
// picker generically — never hardcoded per persona.
export interface PersonaAvailablePlugin {
  id: string
  label: string
}

// Which persona list an entry/edit belongs to — 'admin' backs the pipeline
// when an admin runs it, 'user' backs it for everyone else. Only admins can
// see or edit the 'admin' list; everyone can see (only admins can edit) the
// 'user' list — see VicCoreApi.listPersonaSettings/savePersonaSettings.
export type PersonaScope = 'admin' | 'user'

export interface PersonaSettings {
  id: string
  label: string
  pluginId: string | null
  pluginLabel?: string
  availablePlugins: PersonaAvailablePlugin[]
  fields: PersonaOverrideField[]
  // Second, optional "agent" model level this persona's master model can
  // delegate scoped sub-tasks to. Only true for Dev (Coding) today — the
  // dropdown below is only rendered when this is true.
  supportsAgentLevel: boolean
  agentPluginId: string | null
  agentPluginLabel?: string
  agentFields: PersonaOverrideField[]
}

// Where this server instance is actually storing project files and secrets
// right now (see GET /api/system/storage). projectsRoot reflects what's
// active; projectsRootOverride is the persisted operator setting (may be
// null, or may differ from projectsRoot if a VIC_PROJECTS_ROOT env var is
// currently shadowing it — see projectsRootSource). secretsDir has no
// override: changing it means setting VIC_SECRETS_DIR on the server and
// restarting, not a form field here.
export interface StorageInfo {
  projectsRoot: string
  projectsRootIsDefault: boolean
  projectsRootSource: 'env' | 'override' | 'default'
  projectsRootOverride: string | null
  secretsDir: string
  secretsDirIsDefault: boolean
}

// Stable contract the shell (and any conforming UI) consumes.
// Backed by the core pipeline over HTTP (see httpApi.ts).
export interface VicCoreApi {
  listUsers(): Promise<VicUser[]>
  createUser(name: string): Promise<VicUser>
  listRecentProjects(): Promise<ProjectSummary[]>
  openProject(id: string): Promise<OpenProjectResult>
  createProject(name: string, mode?: ProjectMode): Promise<OpenProjectResult>
  renameProject(id: string, name: string): Promise<ProjectSummary>
  deleteProject(id: string): Promise<void>
  closeProject(): Promise<void>
  getCurrentOperation(): Promise<CurrentOperation>
  getTokenUsage(): Promise<TokenUsage>

  // Requirements elicitation (Area A)
  listRequirements(projectId: string): Promise<Requirement[]>
  createRequirement(projectId: string, text: string): Promise<Requirement>
  analystChat(projectId: string, message: string): Promise<AnalystChatResult>
  acceptProposedRequirement(projectId: string, text: string): Promise<Requirement>
  updateRequirement(projectId: string, requirementId: string, text: string): Promise<Requirement>
  // Split Requirement — propose (LLM call, no mutation), references
  // (mechanical scan across requirements/architecture/planning/testing plus
  // generated code, run before the human commits to applying), apply
  // (mutates: creates the pieces, rewrites structural references, soft-
  // deletes the original).
  proposeSplitRequirement(projectId: string, requirementId: string): Promise<SplitRequirementResult>
  getRequirementReferences(projectId: string, requirementId: string): Promise<RequirementReferencesResult>
  applySplitRequirement(
    projectId: string,
    requirementId: string,
    pieces: SplitPieceInput[],
  ): Promise<ApplySplitRequirementResult>
  estimateAnalysisTokens(projectId: string, requirementIds: string[]): Promise<TokenEstimate>
  analyseRequirements(projectId: string, requirementIds: string[]): Promise<AnalyseResult[]>
  importRequirements(projectId: string, text: string): Promise<Requirement[]>
  checkConflicts(projectId: string): Promise<CheckConflictsResult>
  checkGaps(projectId: string): Promise<string[]>
  getLastChecks(projectId: string): Promise<LastChecksResult>
  getCollapsedRequirementGroups(projectId: string): Promise<string[]>
  setCollapsedRequirementGroups(projectId: string, groupNames: string[]): Promise<void>
  deleteRequirement(projectId: string, requirementId: string): Promise<void>
  listDeletedRequirements(projectId: string): Promise<Requirement[]>
  restoreRequirement(projectId: string, requirementId: string): Promise<Requirement>
  purgeRequirement(projectId: string, requirementId: string): Promise<void>
  reassignRequirementArchitectureElement(
    projectId: string,
    requirementId: string,
    architectureElement: string | null,
  ): Promise<Requirement>
  // Multi-element allocation (chip add/remove in RequirementDetailPanel,
  // drag-and-drop onto a group in RequirementsScreen/ArchitectureScreen) —
  // additive/subtractive, alongside reassignRequirementArchitectureElement
  // above which stays as the single-select replace-style call.
  addRequirementToElement(projectId: string, requirementId: string, elementId: string): Promise<Requirement>
  removeRequirementFromElement(projectId: string, requirementId: string, elementId: string): Promise<Requirement>
  setRequirementStatus(projectId: string, requirementId: string, status: RequirementStatus): Promise<Requirement>
  setAllocationRationale(projectId: string, requirementId: string, rationale: string): Promise<Requirement>

  // Import Project (REQ-055/056) — only valid for a 'import' mode project.
  // previewImportProject reads and parses the given path(s) and computes
  // what importing them would produce, WITHOUT committing anything.
  // saveImportProject then commits whatever was last previewed (no
  // options — replays the staged preview). discardPendingImport cancels a
  // preview without committing it. scanCodeGaps is a separate, explicitly
  // user-triggered, re-runnable step scanning the already-imported code
  // against the current confirmed requirements for gaps.
  // acceptImportedRequirements commits a batch of accepted proposal texts
  // from scanCodeGaps.
  previewImportProject(projectId: string, options: ImportProjectPreviewOptions): Promise<ImportProjectPreview>
  saveImportProject(projectId: string): Promise<ImportProjectPreview>
  discardPendingImport(projectId: string): Promise<void>
  estimateCodeGapScan(projectId: string, stripOptions?: CodeStripOptions): Promise<CodeGapScanTokenEstimate>
  scanCodeGaps(projectId: string, options?: ScanCodeGapsOptions): Promise<ScanCodeGapsResult>
  acceptImportedRequirements(
    projectId: string,
    texts: string[],
    provenance: RequirementProvenance,
  ): Promise<Requirement[]>

  // Architecture type selection (Area B)
  listArchitectureTypes(): Promise<ArchitectureTypeOption[]>
  getArchitectureType(projectId: string): Promise<ArchitectureTypeId | null>
  setArchitectureType(projectId: string, typeId: ArchitectureTypeId): Promise<void>

  // Architecture grid (Area B — static design, allocation, traceability)
  getArchitecture(projectId: string): Promise<Architecture | null>
  createArchitectureElement(
    projectId: string,
    fields: CreateArchitectureElementFields,
  ): Promise<ArchitectureElement>
  updateArchitectureElement(
    projectId: string,
    elementId: string,
    fields: UpdateArchitectureElementFields,
  ): Promise<ArchitectureElement>
  deleteArchitectureElement(projectId: string, elementId: string): Promise<void>
  addArchitectureLayer(projectId: string, label: string): Promise<Architecture>
  removeArchitectureLayer(projectId: string, rowIndex: number): Promise<Architecture>
  checkArchitectureConflicts(projectId: string): Promise<ArchitectureConflict[]>
  autoConfigureAndAllocate(projectId: string): Promise<AutoConfigureAndAllocateResult>
  autoAllocate(projectId: string, mode: 'llm'): Promise<AutoAllocateResult>
  architectChat(projectId: string, message: string): Promise<ArchitectChatResult>
  acceptProposedArchitectureElement(
    projectId: string,
    fields: { kind: ArchitectureElementKind; name: string; layer: string; responsibility: string },
  ): Promise<ArchitectureElement>
  acceptProposedArchitectureInterface(
    projectId: string,
    fromId: string,
    toId: string,
  ): Promise<ArchitectureElement>
  removeArchitectureInterface(projectId: string, fromId: string, toId: string): Promise<ArchitectureElement>
  checkArchitectureInterfaceConflict(
    projectId: string,
    fromId: string,
    toId: string,
  ): Promise<ArchitectureConflict | null>
  defineArchitectureInterfaceDefinition(
    projectId: string,
    fromId: string,
    toId: string,
  ): Promise<InterfaceDefinition>
  defineAllArchitectureInterfaceDefinitions(projectId: string, force?: boolean): Promise<InterfaceDefinition[]>
  // Manual counterpart to defineArchitectureInterfaceDefinition — sets a
  // definition's participants/operations directly, no LLM call. Backs the
  // global/per-element manual interface editor. Creates a new definition
  // when definitionId is omitted.
  setArchitectureInterfaceDefinition(
    projectId: string,
    definitionId: string | undefined,
    name: string,
    participants: Array<{ elementId: string; role: InterfaceRole }>,
    operations: InterfaceContractOperation[],
  ): Promise<InterfaceDefinition>
  // Reconciles one element's own local interface copy against its current
  // master definition — the human review step required before Coding
  // unblocks for that element after a master interface change.
  reconcileArchitectureElementInterface(
    projectId: string,
    definitionId: string,
    elementId: string,
    operations: InterfaceContractOperation[],
  ): Promise<ElementInterfaceDefinition>
  checkArchitectureInterfaces(projectId: string): Promise<CheckInterfacesResult>
  // Compares each defined interface contract's operations against the
  // generated source tree for that pair — the code-vs-Architecture half of
  // interface governance (checkArchitectureInterfaces above only checks
  // whether a contract exists, not whether code matches it).
  checkArchitectureInterfaceCodeAlignment(projectId: string): Promise<CheckInterfaceCodeAlignmentResult>
  // Compares the imported codebase against the confirmed architecture
  // (Import Project, REQ-059/060) — only meaningful once both an
  // architecture and importedCode exist on the project.
  analyzeCodeAlignment(projectId: string): Promise<CodeAlignmentRecord>

  // Coding & Review-Rework (Area D) — strictly element-based; coding is
  // always scoped to exactly one architecture element's own folder.
  scaffoldSourceTree(projectId: string): Promise<{ createdFolders: string[] }>
  listCodingRuns(projectId: string): Promise<CodingRun[]>
  getCodingRun(projectId: string, runId: string): Promise<CodingRun>
  // runToken is generated by the caller (crypto.randomUUID()) before this
  // call so the live-log panel can start polling getCodingRunLog with it
  // immediately, rather than waiting for this (blocking, can take minutes)
  // call to resolve. recode regresses every requirement currently allocated
  // to this element back to 'allocated' server-side first, so an
  // already-'coded' element becomes eligible for another Coding run instead
  // of silently no-opping. fromScratch (only meaningful alongside recode)
  // wipes the element's own scoped subfolder first, so the agent writes
  // fresh code instead of reviewing (and potentially keeping) whatever's
  // already there — no shared-scope conflict is possible anymore (a Coding
  // run always targets exactly one element's own folder).
  runCoding(
    projectId: string,
    architectureElementId: string,
    runToken: string,
    recode?: boolean,
    fromScratch?: boolean,
  ): Promise<{ codingRun: CodingRun }>
  // Checks the code currently in an architecture element's scoped subfolder
  // against the requirements currently allocated to it — read-only, does
  // not touch the working tree or any status (unlike runCoding/recode).
  analyzeElementCode(
    projectId: string,
    architectureElementId: string,
  ): Promise<{ coverage: ElementRequirementCoverage[] }>
  // Polls the accumulated stdout/stderr for an in-flight (or just-finished)
  // Coding-stage CLI run — see packages/server/src/runLogRegistry.ts. done
  // becomes true once the run has fully exited; an unknown/expired token
  // (e.g. the server restarted, or the grace period elapsed) rejects.
  // msSinceLastActivity is how long it's been since the CLI subprocess last
  // produced any output — lets the UI distinguish "actively working" from
  // "stalled" without hardcoding a CLI-specific timeout client-side.
  getCodingRunLog(runToken: string): Promise<{ text: string; done: boolean; msSinceLastActivity: number }>
  // Whether another run (any user/tab) currently holds this project's
  // Coding-run lock — a shared git working tree can't take two concurrent
  // agentic CLI writers, so at most one run is ever in flight per project
  // (see acquireProjectRunLock). Lets the Coding screen show "X is already
  // running Coding here" proactively rather than only after a 409.
  getCodingRunLock(
    projectId: string,
  ): Promise<{ locked: boolean; architectureElementId?: string; userId?: string; startedAt?: number }>
  // Aborts whichever CLI run currently holds this project's Coding
  // run-lock — the Coding screen's lock banner Cancel button. Throws if
  // nothing is locked; the lock is released by the cancelled run's own
  // route handler once its abort actually takes effect, not synchronously
  // by this call.
  cancelCodingRun(projectId: string): Promise<void>
  getCodingConventions(projectId: string): Promise<string>
  setCodingConventions(projectId: string, text: string): Promise<void>
  // Project Overview panel (Architecture tab) — what the app is, what tech
  // it's built with, and how to build/run it. Read into every Coding-stage
  // prompt as extra context; same undefined-until-set convention as coding
  // conventions above.
  getProjectOverview(projectId: string): Promise<{ description: string; runInstructions: string }>
  setProjectOverview(projectId: string, description: string, runInstructions: string): Promise<void>
  // Drafts description/runInstructions from the project's requirements and
  // architecture elements via one LLM call. Does not persist — the caller
  // still needs to call setProjectOverview to save the result.
  autoPopulateProjectOverview(projectId: string): Promise<{ description: string; runInstructions: string }>
  // Lists every file under the project's generated src/ tree (Coding tab
  // "browse files" panel) — root is the absolute filesystem path so the UI
  // can show the user where the files live on disk, not just their names.
  getSourceTree(projectId: string): Promise<{ root: string; files: Array<{ path: string; size: number }> }>
  // URL for a single source file's raw content (GET-able directly, e.g. as
  // an <iframe src> for HTML preview, or via fetch for a text view) — not
  // a fetch wrapper itself since the consumer decides how to load it.
  sourceFileUrl(projectId: string, relativePath: string): string
  downloadSourceTree(projectId: string): Promise<{ blob: Blob; filename: string }>

  // Test Creation (Area E)
  getTestSuite(projectId: string): Promise<TestSuite | null>
  getTestScopeReadiness(projectId: string): Promise<ScopeReadinessEntry[]>
  createTestCase(
    projectId: string,
    fields: CreateTestCaseFields,
  ): Promise<{ testCase: TestCase | null; rejected?: TraceabilityRejectionReason }>
  updateTestCase(projectId: string, testId: string, fields: UpdateTestCaseFields): Promise<TestCase>
  deleteTestCase(projectId: string, testId: string): Promise<void>
  generateFunctionalTests(
    projectId: string,
    architectureElementId: string,
  ): Promise<{ tests: TestCase[]; rejected: RejectedProposal[] }>
  generateIntegrationTests(
    projectId: string,
    fromId: string,
    toId: string,
  ): Promise<{ tests: TestCase[]; rejected: RejectedProposal[] }>
  generateAllTests(projectId: string): Promise<{ tests: TestCase[]; rejected: RejectedProposal[] }>
  generateTestFile(
    projectId: string,
    testId: string,
  ): Promise<{ status: 'success' | 'rejected-scope' | 'rejected-multi-element' | 'cli-error'; testCase: TestCase; diff: string; rawLog: string; rejectedFiles?: string[] }>
  testCreationChat(projectId: string, architectureElementId: string | null, message: string): Promise<TestCreationChatResult>
  acceptProposedTest(projectId: string, proposal: ProposedTest, architectureElementId: string | null): Promise<TestCase>

  // Import legacy test cases (Area E) — scans a server-side folder of
  // existing test files and analyzes each into an untraced ImportedTestCase
  // (see that type's doc comment for why these stay separate from TestSuite).
  getImportedTestCases(projectId: string): Promise<ImportedTestCaseSet | null>
  importLegacyTestCases(projectId: string, folderPath: string): Promise<{ imported: ImportedTestCase[] }>
  deleteImportedTestCase(projectId: string, testId: string): Promise<void>

  // Test Execution (Area F)
  listTestRuns(projectId: string): Promise<TestRun[]>
  getTestRun(projectId: string, runId: string): Promise<TestRun>
  listTestRegressionRuns(projectId: string): Promise<TestRegressionRun[]>
  runElementTests(projectId: string, scope: TestCommandScope): Promise<{ testRun: TestRun }>
  runFullRegression(projectId: string): Promise<{ regressionRun: TestRegressionRun }>
  triageTestFailure(
    projectId: string,
    runId: string,
    testCaseId: string,
  ): Promise<{ triage: TestOutcomeTriage; triageRationale?: string }>
  confirmTestCaseFailure(projectId: string, runId: string, testCaseId: string): Promise<void>
  testExecutionChat(
    projectId: string,
    testCaseId: string | null,
    runId: string | null,
    message: string,
  ): Promise<TestExecutionChatResult>

  // Project settings (requirement 63) — phaseTabGating and unitTestMode
  // (Area E, resolved requirements 53-54) are persisted server-side; the
  // other ProjectSettings fields are still UI-only stub defaults until
  // their backing features exist.
  updateProjectSettings(
    projectId: string,
    updates: Partial<Pick<ProjectSettings, 'phaseTabGating' | 'unitTestMode'>>,
  ): Promise<ProjectSettings>

  // Plugin settings (credentials/config for installed plugin modules)
  listPluginSettings(): Promise<PluginSettings[]>
  savePluginSettings(pluginId: string, values: Record<string, string>): Promise<void>
  // Only meaningful for a plugin with cliCheckable: true. Runs a local,
  // no-tokens-spent check (e.g. `claude --version`) — never a real prompt.
  checkPluginStatus(pluginId: string): Promise<PluginInstallStatus>

  // Current rate-limit/quota usage for a plugin, for the status bar.
  // Rejects if the plugin has no usage concept to report (server 501) or
  // the lookup itself failed (network error, expired credentials, etc.) —
  // callers should treat any rejection as "usage unavailable right now"
  // rather than surfacing raw error text in the status bar.
  getPluginUsage(pluginId: string): Promise<PluginUsage>

  // Where projects/secrets are actually being stored right now.
  getStorageInfo(): Promise<StorageInfo>

  // Sets (pass a path) or clears (pass null) the persisted projectsRoot
  // override. Validates the path is usable server-side before saving.
  // Takes effect on next server restart — see StorageInfo.projectsRootSource.
  setProjectsRootOverride(projectsRootOverride: string | null): Promise<void>

  // Import/Export (Area G) — which project parts exist to export/import,
  // and the export/import actions themselves. Export returns the zip's raw
  // bytes plus the filename the server chose (project name + timestamp) so
  // the caller can trigger a browser download without re-deriving it.
  // Import returns how many items each requested part actually contributed
  // (a part present in the zip but not requested, or requested but absent
  // from the zip, contributes nothing and is omitted from the result).
  listProjectParts(): Promise<ProjectPartInfo[]>
  exportProjectParts(projectId: string, partIds: ProjectPartId[]): Promise<{ blob: Blob; filename: string }>
  importProjectParts(
    projectId: string,
    partIds: ProjectPartId[],
    file: Blob,
  ): Promise<Partial<Record<ProjectPartId, number>>>

  // Migration plan generation (Import Project, REQ-061) — pure/no LLM call,
  // requires projectMode 'import' plus an existing architecture and
  // codeAlignment on the project.
  generateMigrationPlan(projectId: string): Promise<MigrationPlanRecord>

  // Per-persona overrides of a subset of their backing plugin's settings.
  // Two independent lists: 'admin' backs the pipeline when an admin runs
  // it, 'user' backs it for everyone else. Every caller gets back their
  // own 'user' list; the 'admin' key is only present for an admin caller
  // (see GET /api/settings/personas), so its absence is what the UI checks
  // to decide whether to render the admin section at all.
  listPersonaSettings(): Promise<{ admin?: PersonaSettings[]; user: PersonaSettings[] }>
  savePersonaSettings(
    scope: PersonaScope,
    personaId: string,
    values: Record<string, string>,
    pluginId?: string,
    // Agent-level counterparts, only meaningful for a persona with
    // supportsAgentLevel — agentPluginId '' clears the agent-level
    // selection (mirrors clearSelectedAgentPluginId server-side).
    agentValues?: Record<string, string>,
    agentPluginId?: string,
  ): Promise<void>
}
