export const SCHEMA_VERSION = 1

export type RequirementType =
  | 'functional'
  | 'interface-comms'
  | 'data'
  | 'non-functional'
  | 'constraint'
  | 'scheduling'

// Full lifecycle per requirement 10c. Only 'elicited' is reachable at this
// build stage — later stages (architected/allocated/coded/tested/complete)
// are part of the shared type now so downstream modules don't need a
// migration when they start setting them.
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

// The Analyst's own overall verdict (see ANALYSIS_SYSTEM_PROMPT's
// "SEVERITY:" line), distinct from the regex-derived deductions — lets the
// LLM's judgement catch phrasing problems (e.g. speculative language, an
// undefined domain term) that the mechanical rules don't have a check for.
export type AnalystSeverity = 'good' | 'fair' | 'poor'

// 1-5 quality score. The text/conflict deductions are computed locally
// (see qualityScore.ts, INCOSE Guide for Writing Requirements-derived
// heuristics); analystSeverity and its penalty are only present after an
// "Analyse" action has run (see analyseRequirements). Advisory only, per
// the resolved per-requirement quality score design (does not block
// progression).
export interface QualityScore {
  score: number
  deductions: QualityScoreDeduction[]
  conflictPenalty: number
  analystSeverity?: AnalystSeverity
  analystPenalty?: number
}

// One requirement this one is flagged as conflicting with, from the most
// recent Check Conflicts run — carries the rationale text (not just the
// other id) so the requirement's own detail view can show the actual
// finding ("Conflicts with REQ-002: contradictory lockout thresholds"),
// not just an id a human has to go look up elsewhere.
export interface RequirementConflict {
  requirementId: string
  rationale: string
}

// Where a requirement came from (Import Project, REQ-057) — 'human' covers
// both direct form entry and accepting an analyst-chat proposal, since
// those are indistinguishable today and both are user-initiated in the
// moment of creation. The other two values are only stamped by the Import
// Project flow (see codeImport.ts).
export type RequirementProvenance = 'human' | 'imported-document' | 'reverse-elicited-code'

export interface Requirement {
  id: string
  text: string
  type: RequirementType | null
  status: RequirementStatus
  createdAt: string
  provenance: RequirementProvenance
  // Latest per-requirement Analyst review reply (from an explicit
  // "Analyse" action), if one has been run. Distinct from the free-chat
  // proposal flow — this is a standing note attached to the requirement.
  // Undefined means Review Clarity has never run for this requirement —
  // the UI shows "Not Run Yet" rather than hiding the section, so the
  // Analyst notes section is always present (Requirement import/display,
  // resolved).
  analystNote?: string
  // Undefined until Review Clarity or Check Conflicts has run at least
  // once for this requirement — never fabricated as a default.
  qualityScore?: QualityScore
  // Every other active requirement this one is flagged as conflicting with
  // (from the most recent Check Conflicts run), unresolved. Symmetric —
  // both sides of a conflicting pair reference each other. Empty array
  // (not undefined) once Check Conflicts has run and found nothing for
  // this requirement — see conflictsCheckedAt for the "never run" case.
  conflicts?: RequirementConflict[]
  // Set every time Check Conflicts runs for this requirement, even when it
  // comes back clean — the only way to distinguish "never checked" (this
  // field absent, UI shows "Not Run Yet") from "checked, no conflicts"
  // (this field set, conflicts empty, UI shows "None found"), since
  // `conflicts` alone is empty/undefined in both cases.
  conflictsCheckedAt?: string
  // Architecture element(s)/block(s) this requirement has been allocated to
  // (Area B). Always an array, never undefined — empty means unallocated.
  // A requirement may be allocated to more than one element (interface/
  // shared work is expressed this way — each allocated element codes its
  // own side independently, guided by this requirement's text and any
  // relevant InterfaceContract).
  architectureElements: string[]
  // Free-text hint the user can attach to steer Auto Allocate (heuristic and
  // LLM) toward the right architecture element — included in the LLM prompt
  // and folded into the heuristic's keyword-overlap scoring. Undefined until
  // the user sets one.
  allocationRationale?: string
  // Set when the requirement has been soft-deleted (moved to the Bin).
  // Deleted requirements are excluded from the project's active list.
  deletedAt?: string
}

// Preset Architecture types (Area B, resolved) — mirrors
// packages/ui/src/api/types.ts's ArchitectureTypeId. Kept as a plain string
// union here rather than importing the UI package, per the UI-as-a-
// pluggable-module principle (core must not depend on the reference UI).
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

// Grid-based architecture structure (Area B, resolved): every block,
// interface spine, or service occupies one or more cells at a (row, col)
// coordinate. Rows conventionally represent architectural layers, columns
// represent functional groupings. Deterministic — same input always renders
// identically, replacing force-directed layout as the underlying model.
export type ArchitectureElementKind = 'functional' | 'interface-spine' | 'service' | 'external' | 'runtime'

export interface ArchitectureElement {
  id: string
  kind: ArchitectureElementKind
  name: string
  // One-line responsibility statement (Area B, "Service block definition") —
  // captured for every element kind, not just services, since it's what
  // architecture-level conflict detection compares for overlap.
  responsibility: string
  row: number
  col: number
  // Cells spanned beyond the anchor (row, col), both defaulting to 1.
  rowSpan: number
  colSpan: number
  // Interface spine(s) this element exposes/consumes, by element id.
  // Populated for functional/service elements; interface-spine elements
  // themselves don't use this field.
  interfaces: string[]
  // Per-element opt-in override of the project-level dynamic-design
  // default (Area B, "Static vs. dynamic design") — undefined defers to the
  // architecture type's dynamicDesignDefault.
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

// One operation exposed across an interface connection — the unit an
// interface contract (below) is built from. request/response/errors are
// short prose descriptions of data shape, not formal typed schemas,
// matching how the rest of the Architect's proposals stay text-based
// rather than introducing a second schema language into the tool.
export interface InterfaceContractOperation {
  name: string
  description: string
  request: string
  response: string
  errors: string
}

// Structured contract for a single interface connection (one entry per
// fromId|toId pair, undirected — order matches whichever direction was
// defined, not necessarily ArchitectureElement.interfaces' caller|callee
// order). Lives at the architecture level, alongside conflicts, rather
// than on the element itself, since a contract describes the pair, not
// either endpoint alone.
export interface InterfaceContract {
  fromId: string
  toId: string
  operations: InterfaceContractOperation[]
  // 'stale' means the connection still exists but the architecture has
  // changed (an endpoint's responsibility text was edited) since this
  // contract was last defined — surfaced by Check Interfaces, not
  // computed automatically on every edit.
  status: 'defined' | 'stale'
}

export interface Architecture {
  // Layer row labels, seeded from the selected Architecture type's
  // defaultLayers (Area B) — rows are addressed by index into this array.
  layers: string[]
  elements: ArchitectureElement[]
  nextElementSeq: number
  // Most recent architecture-level conflict check result (Area B,
  // "Architecture-level conflict detection") — undefined until Check
  // Conflicts has been run at least once, mirroring requirement conflicts.
  conflicts?: ArchitectureConflict[]
  // Structured interface contracts, one per connected element pair —
  // undefined until Define Interfaces has been run at least once.
  interfaceContracts?: InterfaceContract[]
}

// Phase tab gating (Area G, resolved, requirement 63) — whether later phase
// tabs are disabled until the preceding phase's sign-off. Defaults to
// 'always-accessible': sign-off (requirement 61) isn't built yet, and the
// tool is single-user-only for now, so there's nothing for 'gated' to
// usefully gate on until that lands.
export type PhaseTabGating = 'gated' | 'always-accessible'

// Unit test generation mode (Area E, resolved requirements 53-54) — 'llm'
// proposes tests purely from requirement text; 'scaffold' is intended to
// generate a test-framework skeleton mechanically first and only ask the
// LLM to fill in assertion bodies, but currently behaves identically to
// 'llm' until a concrete per-language scaffold template exists (no
// language is fixed anywhere in generated code yet — the Coding-stage CLI
// agent picks whatever fits each element); 'disabled' skips unit test
// generation entirely. Undefined defaults to 'llm', same "undefined is the
// baseline behaviour" convention as phaseTabGating defaulting to
// 'always-accessible'.
export type UnitTestMode = 'llm' | 'scaffold' | 'disabled'

export interface ProjectSettings {
  phaseTabGating: PhaseTabGating
  unitTestMode?: UnitTestMode
  // Simple-project escape hatch (Area C/D) — undefined defaults to false,
  // same "undefined is the baseline behaviour" convention as the other
  // settings above. Only meaningful for 'new'-mode projects; import-mode
  // projects always require the migration plan regardless of this value.
  // When true, the Coding tab offers a quick inline story-creation form
  // instead of requiring a trip through Planning first.
  allowCodingWithoutPlan?: boolean
}

// One conflicting pair from the most recent Check Conflicts run, kept at
// the project level (in addition to being mirrored onto each side's own
// Requirement.conflicts) so the "Conflict check results" side panel can be
// redisplayed after navigating away and back, instead of only existing as
// transient UI state that vanishes on navigation.
export interface ConflictCheckRecord {
  pairs: Array<{ requirementIds: [string, string]; rationale: string }>
  checkedAt: string
}

// Fixed at project creation (Import Project, REQ-062) and never changed
// afterwards — gates whether import/reverse-elicitation, code alignment,
// and migration-plan generation are active at all. Always 'new' unless the
// project was explicitly created as an import.
export type ProjectMode = 'new' | 'import'

// One imported source file, kept verbatim so reverse elicitation and code
// alignment analysis can both run (and re-run) against it without asking
// the user to re-upload the codebase.
export interface ImportedCodeFile {
  path: string
  content: string
}

export interface ImportedCode {
  files: ImportedCodeFile[]
  importedAt: string
}

// Staged-but-not-yet-committed Import Project data (REQ-055), produced by
// POST /import-project/preview and consumed by POST /import-project/save.
// The preview step runs the real import functions (importRequirementsFromPart/
// importRequirementsFromText/importArchitecturePart, all in elicitation.ts/
// projectParts.ts) against a scratch clone of the project to compute
// accurate counts without mutating the real project; this record freezes
// the already-parsed input data those functions need, so Save can re-run
// them for real against the live project without re-reading the filesystem
// (paths on disk could change between preview and save) or re-parsing.
// Structurally mirrors projectParts.ts's RequirementsPartData/
// ArchitecturePartData rather than importing them, to avoid a circular
// import (projectParts.ts already imports Project from this file).
export interface PendingImportRequirements {
  format: 'vic-export'
  requirements: Requirement[]
}

export interface PendingImportRequirementsTagged {
  format: 'vic-tagged'
  documents: Array<{ path: string; content: string }>
}

export interface PendingImportArchitecture {
  architectureType: ArchitectureTypeId | null
  architecture: Architecture | null
}

export interface PendingImportPreview {
  codeFileCount: number
  requirementsImportedCount: number
  architectureImportedCount: number
}

export interface PendingImport {
  codeFiles: ImportedCodeFile[]
  requirementsImport: PendingImportRequirements | PendingImportRequirementsTagged | null
  architectureImport: PendingImportArchitecture | null
  preview: PendingImportPreview
  stagedAt: string
}

// Per-file verdict from the most recent code alignment analysis
// (Import Project, REQ-059/REQ-060). architectureElementId is null when the
// file couldn't be mapped to any architecture element — that's a flag for
// human review (REQ-060), never a reason to drop the file from the record.
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

// Per-requirement verdict from an architecture element's most recent
// "Analyse Code" run (Dev/Coding phase) — checks the code actually written
// for an element against the requirements currently allocated to it.
// Distinct from CodeAlignmentMapping above: that compares Import Project's
// legacy code against architecture elements; this compares Coding-phase
// output against the specific requirements allocated to an element,
// requirement-by-requirement rather than file-by-file.
export type RequirementCoverageStatus = 'satisfied' | 'partial' | 'not-satisfied'

export interface ElementRequirementCoverage {
  requirementId: string
  status: RequirementCoverageStatus
  rationale: string
}

export interface ElementCodeCheck {
  architectureElementId: string
  coverage: ElementRequirementCoverage[]
  checkedAt: string
}

// One story per architecture element (Import Project, REQ-061), the
// required action derived from that element's alignment status.
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

// Most recent Check Gaps run, kept the same way as ConflictCheckRecord —
// gap suggestions are never auto-created into requirements, so without
// this the only record of "what did the last gap check find" was transient
// React state.
export interface GapCheckRecord {
  suggestions: string[]
  checkedAt: string
}

// Planning (Area C, resolved): decomposed units are "stories" (task-decompos-
// ition scoped at architecture-element level, req 10a). Reuses the same
// 4-state Kanban concept the UI's Status type already renders everywhere
// (phase tabs, sidebar, rows) — duplicated as its own named type here rather
// than imported, per the same core-must-not-depend-on-the-reference-UI rule
// ArchitectureTypeId already follows. NOT RequirementStatus's 6-stage
// pipeline progression — a story is Planning's own work item, a different
// axis from a requirement's position in the whole VIC pipeline.
export type StoryStatus = 'not-started' | 'in-progress' | 'blocked' | 'complete'

// One option considered during the research-before-planning step (resolved),
// attached to the story it informs so it's visible to the human at sign-off,
// not just consumed silently by the LLM.
export interface ResearchOption {
  name: string
  tradeoffs: string
}

export interface Research {
  options: ResearchOption[]
  recommendation: string
  rationale: string
  researchedAt: string
}

export interface Story {
  id: string
  title: string
  description: string
  // Single-element decomposition (req 10a). Null/absent for an interface
  // story, which uses interfaceElementIds instead.
  architectureElementId: string | null
  // Set only for a story covering a 2-element interface requirement (Area B/D
  // "code-change isolation" two-element case) — mirrors how
  // ArchitectureConflict.elementIds and InterfaceContract.fromId/toId already
  // model pairs.
  interfaceElementIds?: [string, string]
  // Requirements this story covers (req 10c traceability) — a story can
  // cover more than one requirement allocated to the same element.
  requirementIds: string[]
  status: StoryStatus
  // Story ids this story depends on (req 10b sequencing), an adjacency list
  // walked the same way ArchitectureElement.interfaces already is for
  // circular-dependency detection.
  dependsOn: string[]
  // Computed sprint-equivalent ordering position; null until Sequencing has
  // run.
  sequence: number | null
  // Present only where research-before-planning found multiple viable
  // approaches (see Research above) — undefined means either research
  // hasn't run yet or found a single obvious approach (reply "NONE").
  research?: Research
  createdAt: string
  // Set when the story has been soft-deleted (moved to the Bin), mirroring
  // Requirement.deletedAt.
  deletedAt?: string
}

export type StorySequencingConflictKind = 'circular-dependency'

export interface StorySequencingConflict {
  id: string
  kind: StorySequencingConflictKind
  storyIds: string[]
  rationale: string
}

// Mirrors Architecture's { elements, nextElementSeq, conflicts? } shape.
export interface Backlog {
  stories: Story[]
  nextStorySeq: number
  conflicts?: StorySequencingConflict[]
}

// Coding & Review-Rework (Area D, resolved). One CLI invocation ("Run
// Coding") against a single architecture element.
// 'rejected-multi-element' is kept in the union even though the current
// element-only Coding path can no longer produce it (every run now has one
// guaranteed-valid element id) — harmless unused member, left in rather
// than removed since nothing depends on removing it.
export type CodingRunStatus =
  | 'success'
  | 'rejected-scope'
  | 'rejected-multi-element'
  | 'rejected-not-eligible'
  | 'rejected-empty-output'
  | 'cli-error'

export interface CodingRun {
  id: string
  architectureElementId: string
  startedAt: string
  finishedAt: string
  status: CodingRunStatus
  // Captured git diff text of the accepted (in-scope) change, empty for a
  // run that wrote nothing accepted.
  diff: string
  // Raw CLI stdout/stderr, shown in the UI's collapsible log.
  rawLog: string
  exitCode: number | null
  // The subfolder (relative to the project's generated source tree) this
  // run was restricted to — the "code-change isolation by architecture
  // element" write-scope gate's allowed prefix for this run.
  allowedSubfolder: string
  // Populated only for status 'rejected-scope' — paths the CLI wrote outside
  // allowedSubfolder that were reverted.
  rejectedFiles?: string[]
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
}

// Test Creation & Execution (Areas E/F, resolved). Integration tests are a
// distinct type from functional (not folded in) — see Area E's resolved
// "Integration tests" section: a functional test derives from one or more
// requirements allocated to one element; an integration test derives from
// an InterfaceContract's operations between two elements.
export type TestType = 'functional' | 'integration'

export type TestCaseStatus = 'not-run' | 'passing' | 'failing'

// Mirrors Story's architectureElementId | interfaceElementIds split
// exactly (single-element vs. 2-element interface case) — a TestCase is
// scoped the same way a Story is, since Test Execution's module-scoped run
// (Area F, resolved) restricts a run's cwd to this same subfolder.
export interface TestCase {
  id: string
  type: TestType
  title: string
  // Functional: every id must resolve to an active (non-deleted)
  // requirement allocated to architectureElementId — enforced by the
  // traceability gate at creation time (testCreation.ts), never merely
  // requested via prompt. Empty for an integration test.
  requirementIds: string[]
  // Integration only — identifies which InterfaceContract (by the same
  // fromId/toId pair key architecture.ts already uses) this test derives
  // from. Undefined for a functional test.
  interfaceContractRef?: { fromId: string; toId: string }
  architectureElementId: string | null
  interfaceElementIds?: [string, string]
  // Path of the generated test source file, relative to the project's
  // generated source tree root — always inside this test's own resolved
  // scope subfolder, the same convention CodingRun.allowedSubfolder
  // already encodes for source files. Undefined until Generate Test File
  // has run for this test.
  filePath?: string
  status: TestCaseStatus
  // Set the moment this test's owning run reports a result — undefined
  // means never run (same undefined-vs-explicit-empty convention as
  // conflictsCheckedAt). Distinct from status, which is the derived
  // display state; this is when it last happened.
  lastRunAt?: string
  createdAt: string
  deletedAt?: string
}

// Mirrors Backlog's { stories, nextStorySeq, conflicts? } shape.
export interface TestSuite {
  tests: TestCase[]
  nextTestSeq: number
}

// A legacy test case imported wholesale from an existing (non-VIC) test
// folder — deliberately NOT a TestCase. TestCase's mechanical
// requirement-traceability gate (testCreation.ts's createTestCase) can only
// ever be satisfied by a real requirement/interface contract already in
// this project, which an imported legacy test has no way of having; forcing
// one would mean either fabricating a fake link (defeats the entire point
// of the gate) or blocking import until every file is manually mapped to a
// requirement first (a much heavier UX than "import legacy test cases" was
// asked for). Imported tests therefore land in their own untraced list,
// visibly flagged as such, and are excluded from every status-flip/
// execution-gate mechanism TestCase participates in. A user who wants one
// fully in the pipeline still goes through the normal Generate/Accept path
// for it by hand — this is a display/inventory feature, not a bypass of the
// gate.
export interface ImportedTestCase {
  id: string
  // Original path relative to the folder that was scanned, e.g.
  // "auth/login.test.ts" — kept for display and to avoid re-importing the
  // same file twice into the same destination path.
  sourceRelativePath: string
  title: string
  description: string
  // Where the verbatim file content was written under this project's own
  // generated source tree (<projectDir>/src/_imported-tests/...), same
  // "real file on disk, not just JSON" convention CodingRun/TestCase's
  // filePath already use — the whole point of importing in "Claude Code
  // format" is that the original .ts test file exists on disk afterward,
  // not just a parsed summary.
  filePath: string
  importedAt: string
}

// Mirrors TestSuite's { tests, nextTestSeq } shape.
export interface ImportedTestCaseSet {
  tests: ImportedTestCase[]
  nextImportedTestSeq: number
}

// One test's outcome within a TestRun (below) — kept per-test rather than
// only a pass/fail count, since the triage step (Area F, resolved) and the
// UI's per-row failing-test display both need per-test detail.
export type TestOutcomeTriage = 'code-failure' | 'test-case-failure' | 'unattributed'

export interface TestCaseOutcome {
  testCaseId: string
  passed: boolean
  // Raw stdout/stderr from the test command, attributed to this specific
  // test case where the runner's output could be parsed per-test, else the
  // whole scoped suite's output shared across every outcome in the same
  // run (see runExecution.ts's pragmatic-regex-with-aggregate-fallback
  // parsing).
  output: string
  // Only ever set when passed is false — the mandatory triage gate (Area
  // F, resolved). 'unattributed' is the state immediately after a failure
  // and before triageTestFailure has run for it; the tool must never
  // auto-resolve out of 'unattributed' without an explicit LLM triage call
  // followed by human confirmation for a 'test-case-failure' verdict.
  triage?: TestOutcomeTriage
  // Free-text rationale from the QA persona's triage reply, shown next to
  // the badge on the failing test's row (Area G, resolved: "surfaces the
  // test-failure triage outcome... directly on each failing test's row").
  triageRationale?: string
  // Set only once a human has explicitly confirmed a 'test-case-failure'
  // triage verdict (Area F, resolved: a human confirms before the test is
  // amended and re-run) — this is the sole gate that lets a
  // 'test-case-failure' outcome stop blocking its requirement's status
  // (see requirementStatusFlip.ts).
  testCaseFailureConfirmedAt?: string
}

export type TestRunKind = 'element-scoped' | 'full-regression'

// One test command invocation, scoped to exactly one element's (or
// interface pair's) own subfolder — Area F's module/element-scoped
// execution gate. A 'full-regression' TestRun is the *aggregate* record
// (TestRegressionRun, below) that wraps one 'element-scoped' TestRun per
// element; the element-scoped runs themselves are still individually
// recorded so a failing element is directly attributable without
// re-deriving it from the aggregate.
export interface TestRun {
  id: string
  kind: TestRunKind
  // The element (or interface pair) this run's cwd was restricted to —
  // undefined only for kind 'full-regression', which has no single scope
  // of its own (see TestRegressionRun.runIds below for its children).
  architectureElementId?: string | null
  interfaceElementIds?: [string, string]
  startedAt: string
  finishedAt: string
  // Raw command exit code — null if the process never started (e.g. no
  // test command configured/resolvable for this element/language yet).
  exitCode: number | null
  rawLog: string
  outcomes: TestCaseOutcome[]
  // Optional mutation-testing score for this run (Area F top-level bullet:
  // "Mutation testing (mechanical, non-LLM)") — deferred, no real
  // Stryker/mutmut/PIT integration exists yet (confirmed acceptable by
  // Mark until a concrete language target is chosen for generated code).
  // Undefined means mutation testing did not run for this scope — never a
  // fabricated 0/100 default.
  mutationScore?: { killed: number; survived: number; percentage: number }
}

// The full-regression aggregate (Area F "Full regression policy",
// resolved) — not a separate artefact in the sense of containing its own
// test definitions, only a record of "these element-scoped runs happened
// together as one regression pass." runIds point at the individual
// element-scoped TestRun entries this regression pass produced.
export interface TestRegressionRun {
  id: string
  startedAt: string
  finishedAt: string
  runIds: string[]
  allPassed: boolean
  // What triggered this pass — 'coding-success' is the automatic trigger
  // (Area F, resolved: "triggered automatically after any accepted Coding
  // run"); 'manual' is the Test Execution screen's on-demand action.
  trigger: 'coding-success' | 'manual'
}

export interface Project {
  schemaVersion: number
  id: string
  name: string
  // Set once at creation (Import Project, REQ-062) and never changed
  // afterwards.
  projectMode: ProjectMode
  requirements: Requirement[]
  // The codebase (+ supporting docs already folded into requirements)
  // uploaded via Import Project, kept for re-running reverse elicitation or
  // code alignment analysis without re-uploading. Only ever set for
  // projectMode 'import'.
  importedCode?: ImportedCode
  // Staged-but-not-yet-committed Import Project data, set by
  // POST /import-project/preview and cleared by either
  // POST /import-project/save (committed) or
  // DELETE /import-project/pending (discarded). Undefined means there is
  // nothing pending — the normal state.
  pendingImport?: PendingImport
  // Most recent code alignment analysis (Import Project, REQ-059/060).
  // Requires architecture and importedCode to exist.
  codeAlignment?: CodeAlignmentRecord
  // Most recent migration plan (Import Project, REQ-061), derived from
  // codeAlignment.
  migrationPlan?: MigrationPlanRecord
  // Null until the Architect selects one at the top of the Architecture tab
  // (Area B, "Architecture type selection").
  architectureType?: ArchitectureTypeId | null
  // Undefined until the Architect selects an architecture type, at which
  // point the grid is seeded with that type's default layer rows.
  architecture?: Architecture
  // Undefined on projects created before this setting existed — callers
  // must fall back to the default (always-accessible), not assume 'gated'.
  settings?: ProjectSettings
  // Undefined until Check Conflicts / Check Gaps have run at least once.
  // Per-requirement analyst notes and conflict details persist on the
  // Requirement itself (see analystNote/conflicts above) and don't need a
  // separate project-level record — this is specifically for the
  // cross-requirement pairs/suggestions list the results panel shows.
  lastConflictCheck?: ConflictCheckRecord
  lastGapCheck?: GapCheckRecord
  // Names of architecture-element groups (or the UNALLOCATED_GROUP sentinel
  // the UI uses for requirements with no architectureElement) currently
  // collapsed in the Requirements list — persisted per-project so a
  // collapsed group stays collapsed next time the project is opened,
  // rather than resetting to fully-expanded every reload. Undefined/absent
  // means nothing is collapsed (the pre-existing, always-expanded default).
  collapsedRequirementGroups?: string[]
  // Planning (Area C) backlog — undefined means Planning hasn't been used
  // yet for this project (same "undefined is the correct never-used state"
  // convention as architecture?).
  backlog?: Backlog
  // Coding (Area D) run history — append-only, one entry per "Run Coding"
  // invocation, kept at the project level so it survives navigation (same
  // rationale as ConflictCheckRecord).
  codingRuns?: CodingRun[]
  // Most recent "Analyse Code" result per architecture element (Area D) —
  // unlike codingRuns this is current-state, not history: a re-run replaces
  // that element's entry rather than appending, since only the latest
  // verdict is ever meaningful (mirrors codeAlignment's
  // single-record-per-analysis shape, just keyed per element instead of
  // project-wide).
  elementCodeChecks?: ElementCodeCheck[]
  // Free-text user-defined coding conventions applied during Coding-stage
  // prompt construction (Area D, resolved). Undefined until the user sets
  // one via the Coding screen's settings panel.
  codingConventions?: string
  // Project-wide default test-run command (Area F, resolved: "tests should
  // be location-agnostic when created, declare their own run command, and
  // share one project-level manifest rather than redeciding per test").
  // Undefined until the FIRST test-file generation call establishes it —
  // that first call asks the coding agent what it used, and every later
  // generation call is told to follow this established convention instead
  // of redeciding (saves tokens on every generation after the first). A
  // per-element deviation from this default is stored separately, on that
  // element's own .vic-element.json marker (see vic-testing's
  // testCommandResolution.ts) rather than here — this field only ever holds
  // the shared default, never an override.
  testCommand?: { command: string; args: string[] }
  // Test Creation (Area E) suite — undefined means Test Creation hasn't
  // been used yet for this project, same "undefined is the never-used
  // state" convention as backlog?.
  testSuite?: TestSuite
  // Imported legacy test cases (Area E, "import legacy test cases") —
  // undefined means nothing has been imported yet. Deliberately separate
  // from testSuite: these are untraced (see ImportedTestCase) and never
  // merge into the gated TestCase list.
  importedTestCases?: ImportedTestCaseSet
  // Test Execution (Area F) run history — append-only, mirrors codingRuns?.
  // Both element-scoped runs (including ones that are part of a regression
  // pass) and standalone on-demand runs live in this same array;
  // testRegressionRuns? separately indexes which runs belong to which
  // regression pass.
  testRuns?: TestRun[]
  testRegressionRuns?: TestRegressionRun[]
}
