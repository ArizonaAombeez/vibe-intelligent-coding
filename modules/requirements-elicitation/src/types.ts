export const SCHEMA_VERSION = 3

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
  // relevant InterfaceDefinition).
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

// Project platform (project harness feature) — the single deployment /
// runtime target for the whole project, one per project (not per element).
// Distinct from ArchitectureTypeId: architectureType only seeds the grid's
// default layer rows, whereas platform drives HOW the harness realises the
// entry point, element instantiation, inter-element links and run
// lifecycle. Orthogonal — a 'web-app' architectureType can target the 'web'
// built-in or a custom 'custom:electron' platform.
export type BuiltInPlatformId = 'embedded' | 'web' | 'android' | 'desktop' | 'cli' | 'server'

// A built-in id, or a user-added custom id of the form "custom:<slug>".
export type PlatformId = BuiltInPlatformId | (string & {})

// One selectable platform. Built-ins are defined in platforms.ts; custom
// ones are user-added and persisted server-side in
// PROJECTS_ROOT/platforms.json. The three *Hint fields are fed verbatim
// into the change-platform warning and the harness Coding prompt.
export interface PlatformDescriptor {
  id: PlatformId
  label: string
  // How the entry point looks on this platform, e.g.
  // "index.html + main.tsx (Vite)", "public static void main",
  // "MainActivity.onCreate".
  entryPointHint: string
  // How elements are wired on this platform, e.g. "React context / props",
  // "Android ViewModel + StateFlow", "constructor injection in main()".
  wiringHint: string
  // The run lifecycle on this platform, e.g. "start only (no stop)",
  // "start + stop via Activity lifecycle", "start + SIGINT stop".
  lifecycleHint: string
  // Built-ins cannot be deleted; custom ones can (by anyone).
  builtIn: boolean
  // Custom platforms only.
  createdBy?: string
  createdAt?: string
}

// Grid-based architecture structure (Area B, resolved): every block,
// interface spine, or service occupies one or more cells at a (row, col)
// coordinate. Rows conventionally represent architectural layers, columns
// represent functional groupings. Deterministic — same input always renders
// identically, replacing force-directed layout as the underlying model.
//
// 'harness' (project harness, resolved): exactly one per project, auto-
// created, non-deletable, excluded from requirement allocation. It is the
// composition root + platform entry point — it instantiates every other
// element, establishes the declared inter-element connections, and drives
// the run lifecycle. It carries no functional logic of its own. Unlike
// every other kind it is coded with write access to the project root (not
// just its own src/ subfolder), because its whole job is to produce the
// entry file the other elements are forbidden from creating. See
// buildHarnessResponsibility / HarnessSpec below and the harness branch in
// vic-coding's runCodingForElement.
export type ArchitectureElementKind =
  | 'functional'
  | 'interface-spine'
  | 'service'
  | 'external'
  | 'runtime'
  | 'harness'

export interface ArchitectureElement {
  id: string
  kind: ArchitectureElementKind
  name: string
  // One-line responsibility statement (Area B, "Service block definition") —
  // captured for every element kind, not just services, since it's what
  // architecture-level conflict detection compares for overlap. This is
  // also this element's required purpose/description (Area B, "each element
  // shall have a description of its purpose") — a required, non-empty
  // field, not a separate optional description on top of it.
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
  // This element's own local copy of every InterfaceDefinition it
  // participates in — see ElementInterfaceDefinition's own comment for why
  // this is a separate per-element copy rather than a live read of the
  // architecture-level definition. Always an array, never undefined; empty
  // means this element hasn't been added as a participant to any
  // definition yet.
  elementInterfaces: ElementInterfaceDefinition[]
  // Per-element opt-in override of the project-level dynamic-design
  // default (Area B, "Static vs. dynamic design") — undefined defers to the
  // architecture type's dynamicDesignDefault.
  dynamicDesignEnabled?: boolean
  // Set by updateRequirementText's regression when an already-coded
  // requirement's text changes, so the next Coding run's prompt can say
  // "you're updating existing code because a requirement changed" instead
  // of a generic re-code framing. Consumed once by buildCodingPrompt
  // (vic-coding) on the next run against this element, then cleared
  // regardless of run outcome — a later plain "Update Code" click with no
  // fresh cause falls back to the generic reason. (Interface-change framing
  // needs no equivalent stored flag — interfaceChangedSinceLastCoding
  // already derives it live from elementInterfaces/codingRuns.) Undefined
  // also covers "no prior successful run yet," which buildCodingPrompt
  // derives itself from an empty codingRuns history.
  //
  // 'user-reported-issue' is set by the Test Execution QA-chat CODE-FAILURE
  // dispatch path (Area F "User-reported issue triage", resolved) — same
  // one-shot consume-then-clear lifecycle, but paired with
  // pendingRecodeDetail since the framing here is the user's own words, not
  // a fixed sentence.
  pendingRecodeReason?: 'requirement-update' | 'user-reported-issue'
  // The user's free-text issue description, set only alongside
  // pendingRecodeReason: 'user-reported-issue' — buildCodingPrompt folds
  // this verbatim into the next run's prompt. Cleared together with
  // pendingRecodeReason.
  pendingRecodeDetail?: string
  // Only ever set on the single kind:'harness' element — the derived plan
  // for how this project's harness realises its entry point, element
  // instantiation, inter-element links and run lifecycle on the currently
  // selected project.platform. Undefined until the Define Harness action
  // has run. Regenerated (not merged) whenever it runs. If
  // harnessSpec.derivedForPlatform !== project.platform the spec is stale
  // and the harness Coding gate refuses to run until Define Harness is
  // re-run. See HarnessSpec below.
  harnessSpec?: HarnessSpec
}

// The default harness responsibility checklist (project harness, resolved).
// Fixed set of concerns a harness must account for; deriveHarnessSpec marks
// each one 'applies' or 'not-applicable' for the selected platform and
// records a one-sentence realisation. Kept as stable keys (never free text)
// so re-derivation on a platform change can match items up.
export type HarnessChecklistKey =
  | 'entry-point'
  | 'element-instantiation'
  | 'inter-element-links'
  | 'lifecycle-start'
  | 'lifecycle-stop'
  | 'config-load'
  | 'dependency-order'
  | 'error-surface'

export type HarnessChecklistStatus = 'applies' | 'not-applicable' | 'unknown'

export interface HarnessChecklistItem {
  key: HarnessChecklistKey
  status: HarnessChecklistStatus
  // One sentence: how this concern is realised on the selected platform
  // (e.g. "Vite index.html loads src/main.tsx which calls createRoot").
  // Reviewable/editable by the user after derivation.
  realisation: string
}

// One declared inter-element connection plus the concrete platform
// mechanism realising it — the "score: Android -> StateFlow on
// GameStateViewModel, observed by HudFragment" artifact. masterDefinitionId
// points at an Architecture.interfaceDefinitions[] entry.
export interface HarnessLinkRealisation {
  masterDefinitionId: string
  summary: string
}

export interface HarnessSpec {
  // The project.platform this spec was derived against. When it no longer
  // matches project.platform the spec is stale (harness Coding blocked).
  derivedForPlatform: PlatformId
  checklist: HarnessChecklistItem[]
  linkRealisations: HarnessLinkRealisation[]
  // One paragraph tying the above together — written verbatim into
  // src/_harness/HARNESS.md by the harness Coding run.
  narrative: string
  derivedAt: string
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
//
// range/resolution/unit/updateFrequency (Area B, interface data-contract
// requirement) describe the signal/value crossing this operation, not just
// its shape — e.g. a sensor reading's valid min/max, its smallest
// meaningful increment, its physical unit, and how often a fresh value is
// available. All four are optional prose (same "text, not a schema
// language" principle as request/response) since not every operation is a
// periodic value (an RPC-style call may have none of these). drivenDirectly
// is set instead of updateFrequency when the value isn't produced on any
// periodic cadence at all and must be pushed/driven into the consumer
// directly before it can be read — the two are mutually exclusive framings
// of the same "when is this fresh" question, not independent fields.
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

// Whether a participant element produces, consumes, or both produces and
// consumes an interface — replaces the old undirected fromId/toId pair
// with an explicit per-participant role, since "which side writes/reads
// this" is real information the old model had no way to express.
export type InterfaceRole = 'produces' | 'consumes' | 'both'

// The project-wide, single source of truth for one interface (Area B) —
// replaces the old one-contract-per-connected-pair model. A definition
// names every element that participates in it (>= 2) and each one's role,
// so a shared bus/topic with N producers/subscribers is ONE definition
// with N participants, not N independently-authored pairwise contracts.
export interface InterfaceDefinition {
  id: string
  name: string
  participants: Array<{ elementId: string; role: InterfaceRole }>
  operations: InterfaceContractOperation[]
  // 'stale' means the participant set still exists but the architecture
  // has changed (an endpoint's responsibility text was edited) since this
  // definition was last defined — surfaced by Check Interfaces, not
  // computed automatically on every edit. Distinct from an element's own
  // copy going out of alignment (ElementInterfaceDefinition.aligned,
  // below), which tracks a different kind of drift.
  status: 'defined' | 'stale'
  // Stamped every time operations or participants change — what
  // ElementInterfaceDefinition.aligned and Coding's
  // interfaceChangedSinceLastCoding compare a coding run's finishedAt
  // against.
  updatedAt: string
  // Platform-neutral per-participant declarations (Define Interfaces, project
  // harness feature). For each participant element: what it does, the named
  // function calls / signals it exposes, the data it owns, and which other
  // elements may see that data. The format is fixed regardless of
  // project.platform — only the harness's realisation notes (HarnessSpec)
  // vary by platform. Undefined on definitions created before this field
  // existed; re-running Define Interfaces backfills it.
  declarations?: InterfaceElementDeclaration[]
}

// One participant element's platform-neutral declaration, emitted by the
// Define Interfaces Architect call alongside the OPERATION lines (project
// harness feature). Merged by elementId across every definition the element
// participates in (union of exposes/owns; last-writer-wins for
// does/visibleTo). The harness reads these to know what to wire without
// having to read every element's source. Names here are conceptual (a call
// or signal name), never a language/framework construct.
export interface InterfaceElementDeclaration {
  elementId: string
  // One line: what this element does. Platform-neutral.
  does: string
  // Named function calls / signals this element exposes to others.
  exposes: string[]
  // Data this element owns (single owner per datum — nothing is global).
  owns: string[]
  // Which elements may see this element's owned data: a list of element
  // ids, or the sentinel ['all'] or ['none'].
  visibleTo: string[]
}

// One element's own local copy of an interface it participates in (Area
// B/D) — lives on ArchitectureElement.elementInterfaces, not here, so an
// element can be coded/tested from its own folder using only what's
// already denormalized onto it, without needing the whole architecture
// loaded. The instant the master InterfaceDefinition it points at changes,
// `aligned` is flipped to false for every participant (architecture.ts) —
// a hard, blocking state (Coding's interfaceGateReasonForElement refuses
// to run while any of an element's own entries are misaligned), not an
// advisory one. A human then reviews the change against this element's
// own requirements, updates `operations` to match the master, which flips
// `aligned` back to true and stamps `reqsCheckedAt`.
export interface ElementInterfaceDefinition {
  masterDefinitionId: string
  role: InterfaceRole
  operations: InterfaceContractOperation[]
  aligned: boolean
  reqsCheckedAt?: string
}

// One operation on a 'defined' definition whose data-contract detail (Area
// B, interface definitions) is incomplete: missing one or more of
// range/resolution/unit, and missing both updateFrequency and
// drivenDirectly (an operation must state one or the other — how often a
// fresh value is available, or that it must be driven/pushed directly —
// never neither). Distinct from an undefined pair (checkInterfaces'
// existing undefinedPairs), which has no definition/operations at all;
// this flags a definition that exists but whose operations aren't fully
// specified.
export interface IncompleteOperation {
  fromId: string
  toId: string
  operationName: string
  missingFields: string[]
}

export interface Architecture {
  // Layer row labels, seeded from the selected Architecture type's
  // defaultLayers (Area B) — rows are addressed by index into this array.
  layers: string[]
  elements: ArchitectureElement[]
  nextElementSeq: number
  // Sequential id counter for InterfaceDefinition (IFACE-NNN), same
  // never-reused rationale as nextElementSeq. Only meaningful once
  // interfaceDefinitions is non-empty; starts at 1 like nextElementSeq.
  nextInterfaceSeq: number
  // Most recent architecture-level conflict check result (Area B,
  // "Architecture-level conflict detection") — undefined until Check
  // Conflicts has been run at least once, mirroring requirement conflicts.
  conflicts?: ArchitectureConflict[]
  // Project-wide master interface definitions — the single source of truth
  // every participant element's own ElementInterfaceDefinition copy is
  // checked against. Undefined until Define Interfaces has been run at
  // least once.
  interfaceDefinitions?: InterfaceDefinition[]
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
  // Coded something, but wrote no runnable "*.test.<ext>" file for the
  // element (Area F follow-up: SW tests are mandatory). The code the agent
  // wrote IS kept (merged and committed like a success — throwing away real
  // work over a missing test would be worse), but the run does NOT count as
  // success: no requirement status flip, and the UI shows it as needing a
  // re-run to add the tests.
  | 'rejected-no-tests'
  // The coding loop (T3) ran to its iteration/time cap without the element's
  // own inline tests passing — code and tests WERE produced (a non-empty
  // diff and >=1 *.test.<ext> file), so this is not 'rejected-*', but it is
  // NOT 'success' either: requirement status does not advance and the
  // element badge shows 'blocked'. A distinct member (not 'success' + a
  // flag) so every `status === 'success'` guard excludes it for free.
  | 'success-tests-failing'
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
  // allowedSubfolder that were reverted. Also populated (without failing the
  // run) for a successful harness run that touched an element's folder: the
  // harness may write the project root + its own _harness/ folder but never
  // an element's folder — such writes are reverted and listed here, and the
  // run still succeeds (see warnings).
  rejectedFiles?: string[]
  // Human-readable advisory notes attached to an otherwise-successful run.
  // Currently only used by the harness branch: when the harness attempted
  // to modify an element's folder, one note per reverted path explaining it
  // may signal a missing requirement or interface. Undefined/absent when
  // there is nothing to flag.
  warnings?: string[]
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
  // Which concrete agent client actually ran this (e.g. 'claude-code' vs
  // 'opencode') and which model was requested — recorded so a slow/fast
  // run can be attributed to a specific provider/model after the fact,
  // not just inferred in the moment from whatever's currently configured.
  // Undefined only for runs that never reached the point of invoking an
  // agent client at all (rejected-not-eligible).
  providerId?: string
  model?: string
  // Provider-agnostic timing breakdown — see AgentRunTiming in
  // vic-llm-claude-code for the full rationale. Populated whenever an
  // agent client actually ran (success, cli-error), regardless of which
  // provider — this is what let a real ~320s stall-before-first-tool-call
  // on one GLM run get diagnosed as provider-side latency rather than
  // VIC's own code, and is what would let the same comparison be made
  // against Claude or any other provider on a later run.
  timing?: {
    msToFirstOutput?: number
    msTotal: number
  }
  // Result of running the element's own freshly-written "*.test.<ext>" files
  // as part of this Coding run (Area F follow-up — "run the coding-level
  // tests and confirm they pass, not just that they exist"). Populated on a
  // run that got far enough to have committed code and at least one test
  // file; absent otherwise. A run whose tests FAIL is still recorded with
  // status 'success' for requirement-status purposes (the code and tests
  // were produced), but swTestsPassed:false is surfaced prominently in the
  // Coding screen and the agent is prompted to fix them on the next run.
  swTestResult?: {
    passed: boolean
    filesRun: number
    // Per-file: basename + pass/fail + captured stdout/stderr.
    files: Array<{ name: string; passed: boolean; output: string }>
  }
  // T3: the coding loop iterates until the element's own definition of done
  // is met (non-empty diff + a test file + inline tests pass + every
  // allocated requirement referenced by a test's `// covers:` tag) or it
  // stops making progress. These record how that went. Absent on a
  // single-shot path (harness runs, gate rejections).
  iterations?: number
  iterationHistory?: Array<{
    status: CodingRunStatus
    swTestsPassed?: boolean
    failingTestNames?: string[]
    // Allocated requirement ids with no `// covers:` tag in any test file
    // after this iteration.
    uncoveredRequirementIds?: string[]
  }>
  stoppedBecause?: 'done' | 'stalled' | 'cap' | 'budget' | 'cancelled' | 'cli-error' | 'rejected'
}

// Test Creation & Execution (Areas E/F, resolved). Integration tests are a
// distinct type from functional (not folded in) — see Area E's resolved
// "Integration tests" section: a functional test derives from one or more
// requirements allocated to one element; an integration test derives from
// an InterfaceDefinition's operations between two elements.
export type TestType = 'functional' | 'integration'

export type TestCaseStatus = 'not-run' | 'passing' | 'failing'

// architectureElementId | interfaceElementIds is single-element vs.
// 2-element interface case — a TestCase is scoped by whichever one is set,
// since Test Execution's module-scoped run (Area F, resolved) restricts a
// run's cwd to this same subfolder.
export interface TestCase {
  id: string
  type: TestType
  title: string
  // Functional: every id must resolve to an active (non-deleted)
  // requirement allocated to architectureElementId — enforced by the
  // traceability gate at creation time (testCreation.ts), never merely
  // requested via prompt. Empty for an integration test.
  requirementIds: string[]
  // Integration only — identifies which InterfaceDefinition this test
  // derives from. Undefined for a functional test.
  interfaceDefinitionId?: string
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
export type TestOutcomeTriage = 'code-failure' | 'test-case-failure' | 'requirement-issue' | 'unattributed'

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
  // Architecture element id(s) triage suspects are actually at fault, most
  // likely first — the LLM is given the full element list (including the
  // Harness element) and asked to name the real culprit, which may differ
  // from or extend the test's static architectureElementId (e.g. the fault
  // is in a collaborator or the Harness wiring). ADVISORY ONLY: this never
  // changes which element gets pendingRecodeReason and never feeds the
  // status-flip gate — it's surfaced on the failing test's row and as chat
  // link chips. Falls back to the static link when the LLM names nothing
  // usable. Undefined on outcomes triaged before this field existed.
  suspectedElementIds?: string[]
}

// One test result from a scope's test command that could not be matched to
// any known (requirement-traced) TestCase title — i.e. a test the coding
// agent wrote inline while implementing the element, never registered via
// Test Creation. Kept separate from TestCaseOutcome (which is always keyed
// to a real TestCase id) since these have no TestCase record to attach
// status/lastRunAt to; name is whatever title the test runner itself
// reported for that individual test.
export interface SwTestOutcome {
  name: string
  passed: boolean
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
  // Test results from this scope's test command that didn't match any known
  // TestCase title — the coding agent's own inline tests (Area F "SW-based
  // tests"). Always present (possibly empty) once individual test titles
  // could be parsed out of the command's output at all; undefined only when
  // the run predates this field or the output couldn't be parsed per-test
  // (see attributeSwOutcomes in runExecution.ts).
  swOutcomes?: SwTestOutcome[]
  // Test cases whose recorded filePath pointed at a file that no longer
  // exists on disk when this run swept the scope (e.g. the source tree was
  // re-coded and the generated test files were lost). runElementTestSuite
  // clears the dead filePath and resets those cases to 'not-run' as it
  // records them here, so the UI can show "file missing — regenerate"
  // instead of silently producing no outcome for them. Undefined on runs
  // that predate this field; empty when every recorded filePath resolved.
  missingFiles?: Array<{ testCaseId: string; filePath: string }>
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
  // True only when at least one requirement-traced outcome ran AND all of
  // them passed. A pass over ZERO outcomes is NOT allPassed — an empty
  // `[].every()` used to report green while nothing had actually run.
  allPassed: boolean
  // How many requirement-traced outcomes this pass actually evaluated. 0
  // means no requirement-level test ran at all (e.g. no automations
  // generated yet) — the UI shows this instead of a bare red so the reason
  // is legible.
  outcomeCount: number
  // What triggered this pass — 'coding-success' is the automatic trigger
  // (Area F, resolved: "triggered automatically after any accepted Coding
  // run"); 'manual' is the Test Execution screen's on-demand action.
  trigger: 'coding-success' | 'manual'
}

// Persistent chat. Before this, every chat was UI-local useState only and
// lost on navigate/reload. A ChatSession is one tab in a screen's chat
// dock; tabs are soft-closed (archivedAt) so a transcript and its dispatch
// history stay auditable. One surface per chat-capable screen:
//   analyst       — Requirements screen (Analyst persona)
//   architect     — Architecture screen (Architect persona)
//   qa-creation   — Test Creation screen (QA persona)
//   qa-execution  — Test Execution screen (QA persona; the only surface
//                   that dispatches, so the only one that populates
//                   ChatMessage.links / ChatMessage.dispatch)
// The Coding screen deliberately has NO chat surface — the process drives
// people through elicitation/architecture/test rather than direct code
// edits.
export type ChatSurface = 'analyst' | 'architect' | 'qa-creation' | 'qa-execution'

// A clickable reference embedded in an assistant chat message — rendered
// as a chip that navigates to the item. label is denormalised at write
// time so the chip still reads sensibly if the target is later renamed or
// deleted (the nav helper handles the not-found case).
export interface ChatMessageLink {
  kind: 'requirement' | 'element' | 'testCase'
  id: string
  label: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  // Only ever populated on assistant messages, and today only on the
  // qa-execution surface (the one chat surface that dispatches). Absent
  // elsewhere.
  links?: ChatMessageLink[]
  // Structured triage/dispatch outcome attached to a qa-execution assistant message —
  // what the DISPATCH_SUMMARY line renders. suspectedElementIds mirrors
  // TestCaseOutcome.suspectedElementIds and is advisory only.
  dispatch?: {
    verdict: 'code-failure' | 'test-case-failure' | 'requirement-issue'
    rationale: string
    dispatchedTo?: string
    suspectedElementIds?: string[]
  }
  createdAt: string
}

export interface ChatSession {
  id: string
  surface: ChatSurface
  // User-editable tab label. Defaults to "Chat N" or a label derived from
  // the focus context at creation time.
  title: string
  // Selection context captured when the tab was opened, passed through to
  // the chat/triage calls this tab makes. Which fields are meaningful
  // depends on the surface (qa: testCaseId/runId; analyst: requirementId;
  // coding: architectureElementId).
  focus?: {
    testCaseId?: string
    runId?: string
    requirementId?: string
    architectureElementId?: string
  }
  messages: ChatMessage[]
  createdAt: string
  updatedAt: string
  // Set when the user closes the tab. The session stays in
  // project.chatSessions (transcript + dispatch history retained); it's
  // just hidden from the tab strip. A hard DELETE route exists but isn't
  // wired to the tab close affordance.
  archivedAt?: string
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
  // The single deployment/runtime platform for this whole project (project
  // harness feature). Undefined until the user picks one on the
  // Architecture screen. The harness element cannot be coded until this is
  // set. Changing it after the fact is a major event — the UI warns and
  // offers to branch to a new project (see branch-platform route). Never
  // guessed from architectureType.
  platform?: PlatformId
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
  // Free-text project overview — what the app is and what tech it's built
  // with — set via the Architecture tab's Project Overview panel (not
  // Settings: it's read alongside the architecture, and Test Full App reads
  // it too). Undefined until the user sets one. Included in every Coding
  // prompt (buildCodingPrompt) as context, same "undefined until set"
  // convention as codingConventions.
  description?: string
  // Free-text build/run instructions (e.g. "npm install && npm run dev") —
  // companion to description, same panel, same undefined-until-set
  // convention. Included in Coding prompts and available to Test Full App.
  runInstructions?: string
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
  // Persistent chat transcripts for the three chat surfaces (see
  // ChatSession). Undefined on projects created before this feature —
  // callers and the store migration normalise it to []. Append-only in
  // practice: tabs are soft-closed via ChatSession.archivedAt, never
  // spliced out here.
  chatSessions?: ChatSession[]
}
