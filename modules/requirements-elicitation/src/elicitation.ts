import {
  buildAnalysisPrompt,
  buildAnalystChatMessages,
  buildConflictCheckPrompt,
  buildGapCheckPrompt,
  buildSplitPrompt,
} from './analystPersona.js'
import { computeQualityScore, parseAnalysisBlocks } from './qualityScore.js'
import type { LlmCallOptions, LlmClient, LlmUsage } from './LlmClient.js'
import type {
  Project,
  QualityScore,
  Requirement,
  RequirementConflict,
  RequirementProvenance,
  RequirementStatus,
} from './types.js'

const REQUIREMENT_LINE = /^REQUIREMENT:\s*(.+)$/gm
const CONFLICT_LINE = /^CONFLICT:\s*(REQ-\d+),\s*(REQ-\d+):\s*(.+)$/gm
const GAP_LINE = /^GAP:\s*(.+?):\s*(.+)$/gm
const PIECE_LINE = /^PIECE:\s*([^|]+)\|\s*(.+)$/gm

// Import format (Requirement import, resolved): each requirement starts
// with a tag+number line (e.g. "REQ_001", "BUG-014" — the tag itself is
// variable, hence a general \w+ prefix rather than a fixed literal) and
// ends with a literal "##END_OF_REQ" line. Text between the two is the
// requirement body, trimmed. `m` + `s` so `.` spans lines within a block
// while `^`/`$` still anchor per-line for the tag/end markers.
const IMPORT_BLOCK = /^([A-Za-z][\w-]*_?\d+)\s*\n([\s\S]*?)\n##END_OF_REQ\s*$/gm

export interface CreateRequirementFields {
  text: string
  // Defaults to 'human' — form entry and chat-proposal-accept are both
  // user-initiated and indistinguishable today. Only the Import Project
  // flow (codeImport.ts) passes an explicit override.
  provenance?: RequirementProvenance
}

export interface ChatWithAnalystResult {
  reply: string
  proposedRequirements: string[]
  usage?: LlmUsage
}

// Structured-intake path (Elicitation UX, resolved). Assigns the next
// permanent REQ-NNN id from a counter shared across every project (not
// reset per project — mirrors SVN's single ever-increasing revision
// number), passed in by the caller since that counter lives outside any
// one Project. Never reused after a deletion.
export function createRequirementFromForm(
  project: Project,
  fields: CreateRequirementFields,
  seq: number,
): Requirement {
  const requirement: Requirement = {
    id: `REQ-${String(seq).padStart(3, '0')}`,
    text: fields.text,
    type: null,
    status: 'elicited',
    createdAt: new Date().toISOString(),
    provenance: fields.provenance ?? 'human',
    architectureElements: [],
  }
  project.requirements.push(requirement)
  return requirement
}

function extractProposedRequirements(reply: string): string[] {
  return Array.from(reply.matchAll(REQUIREMENT_LINE), (m) => m[1].trim())
}

// Analyst-chat path (Elicitation UX, resolved). Does not save anything —
// proposed requirements are returned for the human to accept or discard;
// the caller invokes createRequirementFromForm again for each accepted
// proposal, keeping "resolution is always human" intact.
export async function chatWithAnalyst(
  project: Project,
  llmClient: LlmClient,
  userMessage: string,
  llmOptions?: LlmCallOptions,
): Promise<ChatWithAnalystResult> {
  const messages = buildAnalystChatMessages(activeRequirements(project), userMessage)
  const result = await llmClient.chat(messages, llmOptions)
  return {
    reply: result.content,
    proposedRequirements: extractProposedRequirements(result.content),
    usage: result.usage,
  }
}

// Statuses a requirement can already have reached by the time its text is
// edited again — coding and/or testing may have happened against the old
// text, so the module implementing it needs to be revisited.
const STATUSES_IMPLYING_PRIOR_WORK: RequirementStatus[] = ['coded', 'tested', 'tested-fail', 'complete']

// Plain in-place text edit — no versioning/change-request flow yet, since
// there is no phase sign-off/freeze mechanism to version against
// (Architecture doesn't exist). Throws if the id isn't found so callers
// (the server route) can turn that into a 404 rather than silently no-op.
// Recomputes the quality score (text changed, deductions may have
// changed) but does NOT re-run conflict detection — that needs a fresh
// LLM call over the whole set and doesn't happen automatically on every
// edit, consistent with checks being on-demand, not continuous.
//
// Modularity rule (resolved): a requirement whose text changes after code
// was already written against it (status 'coded'/'tested'/'complete')
// regresses to 'allocated' — the same status Architecture leaves it in
// before Coding first touches it. This is the mechanical "requirement
// changed" signal that run-coding's eligibility gate (see
// packages/server/src/index.ts's run-coding route) checks for, mirroring
// how a failing test already regresses status via applyPassThreshold in
// vic-testing's requirementStatusFlip.ts.
export function updateRequirementText(
  project: Project,
  requirementId: string,
  text: string,
): Requirement {
  const requirement = project.requirements.find((r) => r.id === requirementId && !r.deletedAt)
  if (!requirement) {
    throw new Error(`Requirement ${requirementId} not found`)
  }
  requirement.text = text
  requirement.qualityScore = computeQualityScore(text, requirement.conflicts?.length ?? 0)
  if (STATUSES_IMPLYING_PRIOR_WORK.includes(requirement.status)) {
    requirement.status = 'allocated'
  }
  return requirement
}

// Sets the free-text hint used to steer Auto Allocate (see architecture.ts)
// toward the right element for this requirement. Purely advisory metadata —
// unlike updateRequirementText, this never touches qualityScore.
export function setAllocationRationale(
  project: Project,
  requirementId: string,
  rationale: string,
): Requirement {
  const requirement = project.requirements.find((r) => r.id === requirementId && !r.deletedAt)
  if (!requirement) {
    throw new Error(`Requirement ${requirementId} not found`)
  }
  requirement.allocationRationale = rationale
  return requirement
}

export interface AnalyseResult {
  requirementId: string
  note: string
  qualityScore: QualityScore
}

export interface AnalyseRequirementsResult {
  results: AnalyseResult[]
  usage?: LlmUsage
}

// Structured, single-purpose review — distinct from chatWithAnalyst's
// open-ended elicitation turn. One call over every targeted requirement
// (see buildAnalysisPrompt) rather than one call per requirement — the
// per-requirement loop this replaced resent the system prompt once per
// requirement, which dominated token cost on any non-trivial requirement
// set (see tokenEstimate.ts for the pre-flight estimate this enables).
// Unknown/deleted ids are silently skipped, same as the old loop's `continue`.
export async function analyseRequirements(
  project: Project,
  llmClient: LlmClient,
  requirementIds: string[],
  llmOptions?: LlmCallOptions,
): Promise<AnalyseRequirementsResult> {
  const targeted = requirementIds
    .map((id) => project.requirements.find((r) => r.id === id && !r.deletedAt))
    .filter((r): r is Requirement => r !== undefined)

  if (targeted.length === 0) return { results: [] }

  const messages = buildAnalysisPrompt(targeted)
  const result = await llmClient.chat(messages, llmOptions)
  const blocks = parseAnalysisBlocks(result.content)
  const blocksById = new Map(blocks.map((b) => [b.requirementId, b]))

  const results: AnalyseResult[] = []
  for (const requirement of targeted) {
    const block = blocksById.get(requirement.id)
    if (!block) continue
    requirement.analystNote = block.note
    requirement.qualityScore = computeQualityScore(
      requirement.text,
      requirement.conflicts?.length ?? 0,
      block.severity,
    )
    results.push({ requirementId: requirement.id, note: block.note, qualityScore: requirement.qualityScore })
  }
  return { results, usage: result.usage }
}

export interface ConflictPair {
  requirementIds: [string, string]
  rationale: string
}

export interface CheckConflictsResult {
  pairs: ConflictPair[]
  usage?: LlmUsage
}

function parseConflictLines(reply: string): ConflictPair[] {
  return Array.from(reply.matchAll(CONFLICT_LINE), (m) => ({
    requirementIds: [m[1], m[2]] as [string, string],
    rationale: m[3].trim(),
  }))
}

// One call over the whole requirement set — conflict detection is
// inherently cross-requirement, unlike analyseRequirements' per-requirement
// scope. Sets requirement.conflicts (with rationale text, not just the
// other id — see RequirementConflict) symmetrically on both sides of each
// flagged pair, stamps conflictsCheckedAt on every active requirement so
// "never checked" can be told apart from "checked, clean", recomputes the
// quality score (conflict penalty) for every requirement, and records the
// run on project.lastConflictCheck so the pairs list survives navigation
// instead of only living in transient UI state.
export async function checkConflicts(
  project: Project,
  llmClient: LlmClient,
  llmOptions?: LlmCallOptions,
): Promise<CheckConflictsResult> {
  const active = activeRequirements(project)
  if (active.length === 0) return { pairs: [] }

  const messages = buildConflictCheckPrompt(active)
  const result = await llmClient.chat(messages, llmOptions)
  const knownIds = new Set(active.map((r) => r.id))
  const pairs = parseConflictLines(result.content).filter(
    (pair) => knownIds.has(pair.requirementIds[0]) && knownIds.has(pair.requirementIds[1]),
  )

  const conflictsByReqId = new Map<string, RequirementConflict[]>()
  for (const pair of pairs) {
    const [a, b] = pair.requirementIds
    if (!conflictsByReqId.has(a)) conflictsByReqId.set(a, [])
    if (!conflictsByReqId.has(b)) conflictsByReqId.set(b, [])
    conflictsByReqId.get(a)!.push({ requirementId: b, rationale: pair.rationale })
    conflictsByReqId.get(b)!.push({ requirementId: a, rationale: pair.rationale })
  }

  const checkedAt = new Date().toISOString()
  for (const requirement of active) {
    const conflicts = conflictsByReqId.get(requirement.id) ?? []
    requirement.conflicts = conflicts
    requirement.conflictsCheckedAt = checkedAt
    requirement.qualityScore = computeQualityScore(requirement.text, conflicts.length)
  }

  project.lastConflictCheck = { pairs, checkedAt }

  return { pairs, usage: result.usage }
}

function parseGapLines(reply: string): string[] {
  return Array.from(reply.matchAll(GAP_LINE), (m) => m[1].trim())
}

export interface CheckGapsResult {
  suggestions: string[]
  usage?: LlmUsage
}

// One call over the whole requirement set. Never auto-creates
// requirements — the caller offers Accept/Discard via
// createRequirementFromForm, same pattern as elicitation chat proposals.
// Records the run on project.lastGapCheck (see checkConflicts) so the
// suggestions list survives navigation instead of only living in
// transient UI state.
export async function checkGaps(
  project: Project,
  llmClient: LlmClient,
  llmOptions?: LlmCallOptions,
): Promise<CheckGapsResult> {
  const active = activeRequirements(project)
  if (active.length === 0) return { suggestions: [] }

  const messages = buildGapCheckPrompt(active)
  const result = await llmClient.chat(messages, llmOptions)
  const suggestions = parseGapLines(result.content)
  project.lastGapCheck = { suggestions, checkedAt: new Date().toISOString() }
  return { suggestions, usage: result.usage }
}

// Active (non-deleted) requirements — what listRequirements and every
// group/analysis view should operate over. Deleted requirements stay in
// project.requirements (tagged with deletedAt) rather than a separate
// array, so there's a single source of truth and no id-collision risk
// between the two.
export function activeRequirements(project: Project): Requirement[] {
  return project.requirements.filter((r) => !r.deletedAt)
}

export function deletedRequirements(project: Project): Requirement[] {
  return project.requirements.filter((r) => r.deletedAt)
}

// Persists which architecture-element groups are collapsed in the
// Requirements screen's list view, so a collapsed group stays collapsed
// next time the project is opened. The UI sends the full current set on
// every toggle (collapse/expand one, or collapse/expand all) rather than a
// single add/remove, keeping this a plain replace with no diffing logic.
export function setCollapsedRequirementGroups(project: Project, groupNames: string[]): void {
  project.collapsedRequirementGroups = groupNames
}

// Soft delete — moves the requirement to the Bin. Throws if not found or
// already deleted, so the caller (server route) can turn that into a 404.
export function deleteRequirement(project: Project, requirementId: string): void {
  const requirement = project.requirements.find((r) => r.id === requirementId && !r.deletedAt)
  if (!requirement) {
    throw new Error(`Requirement ${requirementId} not found`)
  }
  requirement.deletedAt = new Date().toISOString()
}

export function restoreRequirement(project: Project, requirementId: string): Requirement {
  const requirement = project.requirements.find((r) => r.id === requirementId && r.deletedAt)
  if (!requirement) {
    throw new Error(`Deleted requirement ${requirementId} not found`)
  }
  requirement.deletedAt = undefined
  return requirement
}

// Permanent delete — only valid on an already-soft-deleted requirement, so
// a stray purge call can't silently hard-delete a live requirement.
export function purgeRequirement(project: Project, requirementId: string): void {
  const index = project.requirements.findIndex((r) => r.id === requirementId && r.deletedAt)
  if (index === -1) {
    throw new Error(`Deleted requirement ${requirementId} not found`)
  }
  project.requirements.splice(index, 1)
}

// Requirement status is advanced only forward, never regressed, by every
// automatic pipeline transition below (allocation -> 'allocated', a
// successful Coding run -> 'coded') — a requirement already further along
// (e.g. manually marked 'complete' via Review Complete, or already
// 'tested'/'complete' from a prior Test Execution pass) must not be pulled
// backward by a later stage's own bookkeeping. Test Execution's own
// pass-threshold flip (vic-testing) is the only place status legitimately
// regresses, and that is an explicit, spec-driven exception (a newly
// failing test), not something earlier stages should ever do.
const STATUS_ORDER: RequirementStatus[] = [
  'elicited',
  'architected',
  'allocated',
  'coded',
  'tested',
  'tested-fail',
  'complete',
]

export function advanceStatusForward(requirement: Requirement, next: RequirementStatus): void {
  if (STATUS_ORDER.indexOf(next) > STATUS_ORDER.indexOf(requirement.status)) {
    requirement.status = next
  }
}

// Second explicit exception to the forward-only rule above (the first is
// Test Execution's pass-threshold flip) — a human deliberately asking to
// recode an already-coded story regresses that story's requirements back to
// 'allocated' so isStoryEligibleForCoding sees pending work again. Unlike
// the pass-threshold flip this is a full regression back to 'allocated'
// (not just to 'coded'), since the whole point is to re-run Coding, not
// just to flag the requirement as needing re-review.
export function regressStatusForRecode(requirement: Requirement): void {
  if (STATUS_ORDER.indexOf(requirement.status) > STATUS_ORDER.indexOf('allocated')) {
    requirement.status = 'allocated'
  }
}

// Allocating a requirement to an architecture element is what "allocated"
// means (Area A/B, req 10c: status attribute per requirement) — this is
// the pipeline's own mechanism for reaching that status, not something a
// human sets by hand the way 'complete' is via Review Complete.
//
// Single-element replace-not-append semantics, preserved unmodified from
// before the architectureElement(s) array rename — existing callers
// (auto-configure-and-allocate's element-creation path, Planning's own
// code if it ever calls this) still get "this requirement now belongs to
// exactly this one element (or none)" behaviour. New multi-element
// allocation goes through addRequirementToElement/removeRequirementFromElement
// below instead.
export function reassignArchitectureElement(
  project: Project,
  requirementId: string,
  architectureElement: string | null,
): Requirement {
  const requirement = project.requirements.find((r) => r.id === requirementId && !r.deletedAt)
  if (!requirement) {
    throw new Error(`Requirement ${requirementId} not found`)
  }
  requirement.architectureElements = architectureElement ? [architectureElement] : []
  if (architectureElement) {
    advanceStatusForward(requirement, 'allocated')
  }
  return requirement
}

// Adds a requirement to an additional architecture element's allocation
// (multi-element allocation, confirmed design decision) — dedupes via Set,
// so adding an element the requirement is already allocated to is a no-op
// besides the status advance. Reachable only via the manual UI (add/remove
// chips) for this migration; auto-allocate stays single-element-per-pass.
export function addRequirementToElement(
  project: Project,
  requirementId: string,
  elementId: string,
): Requirement {
  const requirement = project.requirements.find((r) => r.id === requirementId && !r.deletedAt)
  if (!requirement) {
    throw new Error(`Requirement ${requirementId} not found`)
  }
  requirement.architectureElements = Array.from(new Set([...requirement.architectureElements, elementId]))
  advanceStatusForward(requirement, 'allocated')
  return requirement
}

// Removes a requirement from one architecture element's allocation, leaving
// any other allocated elements untouched. Never regresses status — removing
// one of several allocations doesn't undo coding/testing progress already
// made against the requirement's other allocated elements.
export function removeRequirementFromElement(
  project: Project,
  requirementId: string,
  elementId: string,
): Requirement {
  const requirement = project.requirements.find((r) => r.id === requirementId && !r.deletedAt)
  if (!requirement) {
    throw new Error(`Requirement ${requirementId} not found`)
  }
  requirement.architectureElements = requirement.architectureElements.filter((id) => id !== elementId)
  return requirement
}

// "Review Complete" action (Requirements screen): a human reviewer marking a
// requirement's text as reviewed and settled. Sets status directly to
// 'complete' rather than stepping through architected/allocated/coded/tested
// — those intermediate stages track later pipeline work (this build only
// reaches 'elicited' otherwise) and aren't implied by a text review.
export function setRequirementStatus(
  project: Project,
  requirementId: string,
  status: RequirementStatus,
): Requirement {
  const requirement = project.requirements.find((r) => r.id === requirementId && !r.deletedAt)
  if (!requirement) {
    throw new Error(`Requirement ${requirementId} not found`)
  }
  requirement.status = status
  return requirement
}

// Lets a caller reserve exactly the right size global-seq block (see
// globalSeqStore.ts) before calling importRequirementsFromText, without
// duplicating its parsing.
export function countImportBlocks(text: string): number {
  return Array.from(text.matchAll(IMPORT_BLOCK)).length
}

// Bug-fix/general import path (Requirement import, resolved): the source
// text must be in VIC's tagged import format — each requirement starts with
// a "TAG_NNN"-style line (detected by regex, tag itself variable) and ends
// with a literal "##END_OF_REQ" line. Text that doesn't match this format is
// rejected outright (nothing is imported) rather than guessed at, so a
// pasted document that isn't actually in this format fails loudly instead
// of silently importing garbage blocks. Matched blocks become requirements
// via the same sequential-id path as the structured form
// (createRequirementFromForm), so imported requirements are indistinguishable
// from form-created ones downstream.
// seqStart is the first global sequence number to assign — the caller
// reserves a contiguous block up front (matches.length numbers) since this
// function is synchronous but the global counter (globalSeqStore.ts) is
// file-backed and async.
export function importRequirementsFromText(
  project: Project,
  text: string,
  seqStart: number,
): Requirement[] {
  if (!text.trim()) return []

  const matches = Array.from(text.matchAll(IMPORT_BLOCK))
  if (matches.length === 0) {
    throw new Error(
      'Import text is not in the expected format. Each requirement must start with a ' +
        'tag and number (e.g. "REQ_001") and end with "##END_OF_REQ".',
    )
  }

  return matches.map((m, i) => createRequirementFromForm(project, { text: m[2].trim() }, seqStart + i))
}

// Split Requirement (Requirements screen, resolved) — one proposed
// replacement piece, before it becomes a real requirement. moduleName is
// the LLM's best-guess architecture element *name* (resolved to a real
// element id by the caller, mirroring how chat/architecture proposals
// resolve names to ids only once accepted) — undefined when the LLM
// declined to guess (its NONE column).
export interface ProposedSplitPiece {
  text: string
  moduleName?: string
}

export interface SplitRequirementResult {
  pieces: ProposedSplitPiece[]
  usage?: LlmUsage
}

function parseSplitPieces(reply: string): ProposedSplitPiece[] {
  const pieces: ProposedSplitPiece[] = []
  for (const m of reply.matchAll(PIECE_LINE)) {
    const text = m[1].trim()
    const moduleName = m[2].trim()
    if (!text) continue
    pieces.push(moduleName && moduleName !== 'NONE' ? { text, moduleName } : { text })
  }
  return pieces
}

// Proposes a Split — never mutates the project. The caller reviews (and can
// hand-edit) each piece before calling applySplitRequirement, same
// propose-then-accept shape as every other LLM proposal in this codebase.
export async function splitRequirement(
  project: Project,
  llmClient: LlmClient,
  requirementId: string,
  llmOptions?: LlmCallOptions,
): Promise<SplitRequirementResult> {
  const requirement = project.requirements.find((r) => r.id === requirementId && !r.deletedAt)
  if (!requirement) {
    throw new Error(`Requirement ${requirementId} not found`)
  }
  const elements = project.architecture?.elements ?? []
  const messages = buildSplitPrompt(requirement, elements)
  const result = await llmClient.chat(messages, llmOptions)

  if (result.content.trim() === 'NONE') {
    return { pieces: [], usage: result.usage }
  }
  return { pieces: parseSplitPieces(result.content), usage: result.usage }
}

// One place a requirement id is referenced from, outside the requirement's
// own record — surfaced to the human before a Split (or any other
// requirement-removing action) actually removes the original, so nothing
// downstream silently ends up pointing at a dangling id. `kind` is a
// stable machine-readable tag the UI groups by; `label` is what to show.
export type RequirementReferenceKind =
  | 'conflict'
  | 'story'
  | 'test-case'
  | 'analyst-note-mention'
  | 'conflict-rationale-mention'
  | 'story-text-mention'
  | 'test-case-title-mention'

export interface RequirementReference {
  kind: RequirementReferenceKind
  label: string
}

// requirementId's own "REQ-NNN" pattern, scoped to one specific id per call
// (not the shared app-wide REQ_ID_PATTERN in the UI, which matches any id)
// so a caller scanning for REQ-002's references never accidentally matches
// REQ-2 or REQ-0002-typo text.
function mentionPattern(requirementId: string): RegExp {
  return new RegExp(`\\b${requirementId}\\b`)
}

// Structured-field references (Story.requirementIds, TestCase.requirementIds,
// RequirementConflict.requirementId) are exact — walking the arrays those
// fields already are. Free-text mentions (analyst notes, conflict
// rationales, story/test titles/descriptions) are a best-effort regex scan
// over the same "REQ-NNN" convention requirementIdHighlight.tsx already
// renders clickable in the UI — a prose reference an LLM wrote, not a
// structural link, so it can't be corrected automatically and is only ever
// reported, never rewritten.
export function findRequirementReferences(project: Project, requirementId: string): RequirementReference[] {
  const references: RequirementReference[] = []
  const mentions = mentionPattern(requirementId)

  for (const r of project.requirements) {
    if (r.id === requirementId || r.deletedAt) continue
    if (r.conflicts?.some((c) => c.requirementId === requirementId)) {
      references.push({ kind: 'conflict', label: `${r.id} (Check Conflicts result)` })
    }
    for (const c of r.conflicts ?? []) {
      if (c.requirementId !== requirementId && mentions.test(c.rationale)) {
        references.push({ kind: 'conflict-rationale-mention', label: `${r.id}'s conflict rationale` })
      }
    }
    if (r.analystNote && mentions.test(r.analystNote)) {
      references.push({ kind: 'analyst-note-mention', label: `${r.id}'s Analyst note` })
    }
  }

  for (const story of project.backlog?.stories ?? []) {
    if (story.deletedAt) continue
    if (story.requirementIds.includes(requirementId)) {
      references.push({ kind: 'story', label: `${story.id}: ${story.title}` })
    } else if (mentions.test(story.title) || mentions.test(story.description)) {
      references.push({ kind: 'story-text-mention', label: `${story.id}: ${story.title} (text mention)` })
    }
  }

  for (const test of project.testSuite?.tests ?? []) {
    if (test.deletedAt) continue
    if (test.requirementIds.includes(requirementId)) {
      references.push({ kind: 'test-case', label: `${test.id}: ${test.title}` })
    } else if (mentions.test(test.title)) {
      references.push({ kind: 'test-case-title-mention', label: `${test.id}: ${test.title} (text mention)` })
    }
  }

  return references
}

export interface SplitPieceInput {
  text: string
  // Resolved architecture element id (already looked up from the proposed
  // moduleName, or hand-picked by the user) — null leaves the new
  // requirement unallocated, same as any freshly created requirement.
  architectureElementId: string | null
}

export interface ApplySplitRequirementResult {
  createdRequirements: Requirement[]
  // Ids of stories/tests whose requirementIds were rewritten (old id
  // removed, every new id added) — reported back so the caller can surface
  // "N structured references were updated" alongside the reference-check
  // report's free-text mentions, which are never auto-rewritten.
  updatedStoryIds: string[]
  updatedTestCaseIds: string[]
}

// Applies a reviewed Split: creates one new requirement per piece (new
// permanent ids from seqStart, same reserve-a-block convention as
// importRequirementsFromText), rewrites every *structured* reference this
// module can safely resolve (Story.requirementIds, TestCase.requirementIds)
// to point at the new ids instead, then soft-deletes the original —
// deleteRequirement's existing Bin/restore path is the safety net if this
// needs undoing, never a hard purge. Free-text mentions found by
// findRequirementReferences are deliberately left untouched (see that
// function's docs) — the caller is expected to have shown those to the user
// before calling this.
export function applySplitRequirement(
  project: Project,
  requirementId: string,
  pieces: SplitPieceInput[],
  seqStart: number,
): ApplySplitRequirementResult {
  const original = project.requirements.find((r) => r.id === requirementId && !r.deletedAt)
  if (!original) {
    throw new Error(`Requirement ${requirementId} not found`)
  }
  if (pieces.length < 2) {
    throw new Error('A split must produce at least two replacement requirements')
  }

  const createdRequirements = pieces.map((piece, i) => {
    const requirement = createRequirementFromForm(project, { text: piece.text }, seqStart + i)
    requirement.architectureElements = piece.architectureElementId ? [piece.architectureElementId] : []
    return requirement
  })
  const newIds = createdRequirements.map((r) => r.id)

  const updatedStoryIds: string[] = []
  for (const story of project.backlog?.stories ?? []) {
    if (story.deletedAt || !story.requirementIds.includes(requirementId)) continue
    story.requirementIds = Array.from(
      new Set(story.requirementIds.flatMap((id) => (id === requirementId ? newIds : [id]))),
    )
    updatedStoryIds.push(story.id)
  }

  const updatedTestCaseIds: string[] = []
  for (const test of project.testSuite?.tests ?? []) {
    if (test.deletedAt || !test.requirementIds.includes(requirementId)) continue
    test.requirementIds = Array.from(
      new Set(test.requirementIds.flatMap((id) => (id === requirementId ? newIds : [id]))),
    )
    updatedTestCaseIds.push(test.id)
  }

  deleteRequirement(project, requirementId)

  return { createdRequirements, updatedStoryIds, updatedTestCaseIds }
}
