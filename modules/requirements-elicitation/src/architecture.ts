import { findArchitectureType } from './architectureTypes.js'
import { buildArchitectChatMessages, DEFINE_INTERFACE_CONTRACT_SYSTEM_PROMPT } from './architecturePersona.js'
import { addRequirementToElement } from './elicitation.js'
import type { LlmCallOptions, LlmClient, LlmUsage } from './LlmClient.js'
import type {
  Architecture,
  ArchitectureConflict,
  ArchitectureConflictKind,
  ArchitectureElement,
  ArchitectureElementKind,
  ArchitectureTypeId,
  InterfaceContract,
  InterfaceContractOperation,
  Project,
  Requirement,
} from './types.js'

// Reserved row for external/context elements (Area B, "external modules
// shown outside the main architecture, as context") — negative so it can
// never collide with a real layer index and survives addLayer/removeLayer,
// both of which only ever touch rows >= 0. The grid renderer draws this row
// above row 0, visually separated by a gap, and always grey regardless of
// kind-specific styling.
export const EXTERNAL_CONTEXT_ROW = -1

// Selecting a type only seeds the grid the first time (Area B, "Architecture
// type selection") — re-selecting after elements exist must not silently
// wipe the Architect's work, so this only (re)initialises architecture when
// it doesn't exist yet.
export function setArchitectureType(project: Project, typeId: ArchitectureTypeId): void {
  project.architectureType = typeId
  if (project.architecture) return

  const preset = findArchitectureType(typeId)
  project.architecture = {
    // Copy, not a reference — otherwise addLayer/removeLayer on this
    // project's grid would mutate the shared ARCHITECTURE_TYPES preset
    // array, corrupting it for every other project using the same type.
    layers: [...(preset?.defaultLayers ?? [])],
    elements: [],
    nextElementSeq: 1,
  }
}

export interface CreateElementFields {
  kind: ArchitectureElementKind
  name: string
  responsibility: string
  row: number
  col: number
  rowSpan?: number
  colSpan?: number
  interfaces?: string[]
}

function requireArchitecture(project: Project): Architecture {
  if (!project.architecture) {
    throw new Error('Project has no architecture — select an Architecture type first')
  }
  return project.architecture
}

// Ids are permanent and sequential (ARCH-NNN), same rationale as REQ-NNN —
// never reused after deletion, so stale references (e.g. a requirement's
// architectureElement, or a conflict's elementIds) never silently point at
// a different element later.
export function createArchitectureElement(
  project: Project,
  fields: CreateElementFields,
): ArchitectureElement {
  const architecture = requireArchitecture(project)
  const seq = architecture.nextElementSeq
  const element: ArchitectureElement = {
    id: `ARCH-${String(seq).padStart(3, '0')}`,
    kind: fields.kind,
    name: fields.name,
    responsibility: fields.responsibility,
    row: fields.row,
    col: fields.col,
    rowSpan: fields.rowSpan ?? 1,
    colSpan: fields.colSpan ?? 1,
    interfaces: fields.interfaces ?? [],
  }
  architecture.nextElementSeq = seq + 1
  architecture.elements.push(element)
  return element
}

export interface UpdateElementFields {
  name?: string
  responsibility?: string
  row?: number
  col?: number
  rowSpan?: number
  colSpan?: number
  interfaces?: string[]
  dynamicDesignEnabled?: boolean
}

export function updateArchitectureElement(
  project: Project,
  elementId: string,
  fields: UpdateElementFields,
): ArchitectureElement {
  const architecture = requireArchitecture(project)
  const element = architecture.elements.find((e) => e.id === elementId)
  if (!element) {
    throw new Error(`Architecture element ${elementId} not found`)
  }
  Object.assign(element, fields)
  return element
}

// Deleting an element also clears it from any other element's interfaces
// list and from any requirement allocated to it (falls back to
// unallocated), so nothing is left pointing at a dangling id.
export function deleteArchitectureElement(project: Project, elementId: string): void {
  const architecture = requireArchitecture(project)
  const index = architecture.elements.findIndex((e) => e.id === elementId)
  if (index === -1) {
    throw new Error(`Architecture element ${elementId} not found`)
  }
  architecture.elements.splice(index, 1)
  for (const element of architecture.elements) {
    element.interfaces = element.interfaces.filter((id) => id !== elementId)
  }
  for (const requirement of project.requirements) {
    requirement.architectureElements = requirement.architectureElements.filter((id) => id !== elementId)
  }
  architecture.conflicts = architecture.conflicts?.filter((c) => !c.elementIds.includes(elementId))
}

export function addLayer(project: Project, label: string): void {
  const architecture = requireArchitecture(project)
  architecture.layers.push(label)
}

export function removeLayer(project: Project, rowIndex: number): void {
  const architecture = requireArchitecture(project)
  if (rowIndex < 0 || rowIndex >= architecture.layers.length) {
    throw new Error(`Layer row ${rowIndex} does not exist`)
  }
  architecture.layers.splice(rowIndex, 1)
  // Elements anchored on the removed row collapse onto the row that takes
  // its place; elements below shift up by one to stay contiguous — this
  // mirrors a normal spreadsheet row-delete rather than leaving a gap.
  for (const element of architecture.elements) {
    if (element.row >= architecture.layers.length) {
      element.row = Math.max(0, architecture.layers.length - 1)
    } else if (element.row > rowIndex) {
      element.row -= 1
    }
  }
}

const CIRCULAR_DEP_KIND: ArchitectureConflictKind = 'circular-dependency'

// Mechanical (non-LLM) circular-dependency detection over the
// element-to-element interface graph — a pure graph-cycle check, unlike the
// LLM-assisted mismatch/overlap checks below, since "does this graph have a
// cycle" doesn't need judgement.
function detectCircularDependencies(elements: ArchitectureElement[]): ArchitectureConflict[] {
  const byId = new Map(elements.map((e) => [e.id, e]))
  const conflicts: ArchitectureConflict[] = []
  const seenCycles = new Set<string>()

  function dfs(startId: string, currentId: string, visited: Set<string>, path: string[]): void {
    const current = byId.get(currentId)
    if (!current) return
    for (const nextId of current.interfaces) {
      if (nextId === startId && path.length > 0) {
        const cycle = [...path, currentId, startId]
        const key = Array.from(new Set(cycle)).sort().join(',')
        if (!seenCycles.has(key)) {
          seenCycles.add(key)
          conflicts.push({
            id: '',
            kind: CIRCULAR_DEP_KIND,
            elementIds: Array.from(new Set(cycle)),
            rationale: `Circular dependency: ${cycle.join(' -> ')}`,
          })
        }
        continue
      }
      if (visited.has(nextId)) continue
      dfs(startId, nextId, new Set(visited).add(nextId), [...path, currentId])
    }
  }

  for (const element of elements) {
    dfs(element.id, element.id, new Set([element.id]), [])
  }
  return conflicts
}

const INTERFACE_MISMATCH_LINE = /^MISMATCH:\s*(ARCH-\d{3}),\s*(ARCH-\d{3}):\s*(.+)$/gm
const OVERLAP_LINE = /^OVERLAP:\s*(ARCH-\d{3}),\s*(ARCH-\d{3}):\s*(.+)$/gm

const ARCHITECTURE_CONFLICT_SYSTEM_PROMPT = `You are the Architect, checking a system architecture for two kinds of
problems: interface/contract mismatches, and overlapping/duplicate block
responsibilities.

An interface/contract mismatch is when two elements connected via a shared
interface appear to expect incompatible data shapes or protocols, based on
their name/responsibility text.

An overlapping responsibility is when two elements' responsibility
statements substantially describe the same behaviour, suggesting duplicated
or unclear ownership.

For each mismatch you find, reply on its own line using exactly this format:

MISMATCH: ARCH-NNN, ARCH-MMM: <short rationale>

For each overlap you find, reply on its own line using exactly this format:

OVERLAP: ARCH-NNN, ARCH-MMM: <short rationale>

Only flag pairs you are confident about. If you find neither, reply with
the single word: NONE.`

function formatElementList(elements: ArchitectureElement[]): string {
  return elements
    .map((e) => `- ${e.id} (${e.kind}): ${e.name} — ${e.responsibility}`)
    .join('\n')
}

export interface CheckArchitectureConflictsResult {
  conflicts: ArchitectureConflict[]
  usage?: LlmUsage
}

// Mirrors checkConflicts' pattern (Requirements, Area A): mechanical checks
// run unconditionally; the LLM-assisted checks make one call over the whole
// element set and are skipped if there are no elements. Resolution is
// always human — this only detects and records, never auto-resolves.
export async function checkArchitectureConflicts(
  project: Project,
  llmClient: LlmClient,
  llmOptions?: LlmCallOptions,
): Promise<CheckArchitectureConflictsResult> {
  const architecture = requireArchitecture(project)
  const circular = detectCircularDependencies(architecture.elements)

  if (architecture.elements.length === 0) {
    architecture.conflicts = circular.map((c, i) => ({ ...c, id: `CONF-${i + 1}` }))
    return { conflicts: architecture.conflicts }
  }

  const messages = [
    { role: 'system' as const, content: ARCHITECTURE_CONFLICT_SYSTEM_PROMPT },
    { role: 'user' as const, content: formatElementList(architecture.elements) },
  ]
  const result = await llmClient.chat(messages, llmOptions)
  const knownIds = new Set(architecture.elements.map((e) => e.id))

  const mismatches: ArchitectureConflict[] = Array.from(
    result.content.matchAll(INTERFACE_MISMATCH_LINE),
    (m) => ({
      id: '',
      kind: 'interface-mismatch' as ArchitectureConflictKind,
      elementIds: [m[1], m[2]],
      rationale: m[3].trim(),
    }),
  ).filter((c) => c.elementIds.every((id) => knownIds.has(id)))

  const overlaps: ArchitectureConflict[] = Array.from(
    result.content.matchAll(OVERLAP_LINE),
    (m) => ({
      id: '',
      kind: 'overlapping-responsibility' as ArchitectureConflictKind,
      elementIds: [m[1], m[2]],
      rationale: m[3].trim(),
    }),
  ).filter((c) => c.elementIds.every((id) => knownIds.has(id)))

  const all = [...circular, ...mismatches, ...overlaps].map((c, i) => ({
    ...c,
    id: `CONF-${i + 1}`,
  }))
  architecture.conflicts = all
  return { conflicts: all, usage: result.usage }
}

const AUTO_CONFIGURE_SYSTEM_PROMPT = `You are the Architect. Group the given requirements into cohesive
architecture modules, place each module in a layer, connect modules that
depend on each other, and allocate every requirement to the module that
satisfies it.

Available layers (use the exact label, top to bottom): {{LAYERS}}

If existing modules are listed, prefer allocating a requirement to one of
them over proposing a near-duplicate new module. Only propose a new module
when no existing one reasonably covers the requirement.

If a requirement implies an outside system or actor the software depends on
or interacts with but does not implement (e.g. a third-party payment
provider, an external sensor, another organisation's system), propose it as
an "external" module — these represent context, not something to be built.

Reply using exactly these line formats, one per line, nothing else:

MODULE: <kind>|<layer>|<name>|<short responsibility>
  kind is one of: functional, service, interface-spine, runtime, external
  layer is one of the layers listed above, or the word NONE for an
  external module (external modules are not placed on a layer).

ALLOCATE: <requirement id>|<module name>
  One line per requirement passed to you. <module name> must exactly match
  a MODULE name above (new or existing) — never leave a requirement
  unallocated if any module plausibly covers it.

INTERFACE: <module name>|<module name>
  One line per pair of modules that depend on each other (caller|callee).
  Omit if a module has no dependencies.

Use each module name consistently across MODULE/ALLOCATE/INTERFACE lines.
If nothing can be confidently grouped, reply with the single word: NONE.`

export const MODULE_LINE = /^MODULE:\s*([a-z-]+)\s*\|\s*([^|]*)\|\s*([^|]+)\|\s*(.+)$/gm
const ALLOCATE_LINE = /^ALLOCATE:\s*(REQ-\d+)\s*\|\s*(.+)$/gm
export const INTERFACE_LINE = /^INTERFACE:\s*([^|]+)\|\s*(.+)$/gm

const VALID_MODULE_KINDS = new Set<ArchitectureElementKind>([
  'functional',
  'service',
  'interface-spine',
  'runtime',
  'external',
])

function formatExistingModules(elements: ArchitectureElement[]): string {
  if (elements.length === 0) return '(none yet)'
  return elements.map((e) => `- ${e.name} (${e.kind}): ${e.responsibility}`).join('\n')
}

function formatUnallocatedRequirements(requirements: Requirement[]): string {
  return requirements
    .map((r) => `${r.id}: ${r.text}${r.allocationRationale ? ` (rationale: ${r.allocationRationale})` : ''}`)
    .join('\n')
}

function addUsage(a: LlmUsage | undefined, b: LlmUsage | undefined): LlmUsage | undefined {
  if (!a) return b
  if (!b) return a
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  }
}

// Deterministic placement for newly-created modules: internal (non-external)
// modules fill columns left-to-right within their chosen layer row, packed
// after whatever already occupies that row; external modules always land on
// the reserved EXTERNAL_CONTEXT_ROW, packed the same way — kept out of the
// main layer grid entirely, per the "external shown outside, as context"
// layout rule.
export function nextFreeColumn(elements: ArchitectureElement[], row: number): number {
  const occupied = elements.filter((e) => e.row === row)
  if (occupied.length === 0) return 0
  return Math.max(...occupied.map((e) => e.col + e.colSpan))
}

export interface AutoConfigureAndAllocateResult {
  createdElements: ArchitectureElement[]
  allocatedRequirementIds: string[]
  unallocatedRequirementIds: string[]
  usage?: LlmUsage
}

// "Auto Configure & Allocate" (Area B) — one LLM call groups the project's
// currently-unallocated requirements into modules, then this parses the
// reply into real architecture elements, interfaces, and allocations.
// Non-destructive re-run: existing elements and already-allocated
// requirements are left untouched — only gaps are filled, so running this
// again after adding new requirements just tops up the grid.
//
// Import Project (REQ-058): this must design from the confirmed requirement
// set alone, even for an import-mode project — it must never read
// project.importedCode or any other legacy-code content. Keep it that way
// if this function changes; the target architecture is meant to be the
// ideal design, not a description of the existing codebase's structure.
export async function autoConfigureAndAllocate(
  project: Project,
  llmClient: LlmClient,
  llmOptions?: LlmCallOptions,
): Promise<AutoConfigureAndAllocateResult> {
  const architecture = requireArchitecture(project)
  const unallocated = project.requirements.filter((r) => !r.deletedAt && r.architectureElements.length === 0)

  if (unallocated.length === 0) {
    return { createdElements: [], allocatedRequirementIds: [], unallocatedRequirementIds: [] }
  }

  const layersText = architecture.layers.length > 0 ? architecture.layers.join(', ') : '(no layers defined)'
  const systemPrompt = AUTO_CONFIGURE_SYSTEM_PROMPT.replace('{{LAYERS}}', layersText)
  const userPrompt = `Existing modules:\n${formatExistingModules(architecture.elements)}\n\nRequirements to allocate:\n${formatUnallocatedRequirements(unallocated)}`

  const messages = [
    { role: 'system' as const, content: systemPrompt },
    { role: 'user' as const, content: userPrompt },
  ]
  const result = await llmClient.chat(messages, llmOptions)

  const byName = new Map<string, ArchitectureElement>(architecture.elements.map((e) => [e.name, e]))
  const createdElements: ArchitectureElement[] = []

  for (const m of result.content.matchAll(MODULE_LINE)) {
    const kind = m[1].trim() as ArchitectureElementKind
    const layerLabel = m[2].trim()
    const name = m[3].trim()
    const responsibility = m[4].trim()
    if (!VALID_MODULE_KINDS.has(kind) || byName.has(name)) continue

    const isExternal = kind === 'external'
    const row = isExternal ? EXTERNAL_CONTEXT_ROW : architecture.layers.indexOf(layerLabel)
    if (!isExternal && row === -1) continue // layer name didn't match any real layer — skip rather than guess

    const element = createArchitectureElement(project, {
      kind,
      name,
      responsibility,
      row,
      col: nextFreeColumn(architecture.elements, row),
    })
    byName.set(name, element)
    createdElements.push(element)
  }

  for (const m of result.content.matchAll(INTERFACE_LINE)) {
    const from = byName.get(m[1].trim())
    const to = byName.get(m[2].trim())
    if (!from || !to || from.id === to.id) continue
    if (!from.interfaces.includes(to.id)) from.interfaces.push(to.id)
  }

  const allocatedRequirementIds: string[] = []
  const unallocatedIds = new Set(unallocated.map((r) => r.id))
  for (const m of result.content.matchAll(ALLOCATE_LINE)) {
    const requirementId = m[1].trim()
    const target = byName.get(m[2].trim())
    if (!target || !unallocatedIds.has(requirementId)) continue
    addRequirementToElement(project, requirementId, target.id)
    allocatedRequirementIds.push(requirementId)
    unallocatedIds.delete(requirementId)
  }

  return {
    createdElements,
    allocatedRequirementIds,
    unallocatedRequirementIds: Array.from(unallocatedIds),
    usage: result.usage,
  }
}

export interface AutoAllocateResult {
  allocatedRequirementIds: string[]
  unallocatedRequirementIds: string[]
  usage?: LlmUsage
}

// Small English stopword set for the heuristic allocator's keyword-overlap
// scoring — just enough to stop "the"/"a"/"shall" etc. from dominating the
// match score, not a full NLP stack (this is a first-pass local fallback,
// not a replacement for the LLM mode).
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is',
  'are', 'be', 'shall', 'must', 'should', 'will', 'this', 'that', 'it', 'as',
  'by', 'at', 'from', 'when', 'if', 'then', 'not', 'so', 'can', 'may',
])

function significantWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2 && !STOPWORDS.has(word)),
  )
}

// Lightweight cues nudging the heuristic allocator toward interface/runtime
// -flavoured elements for requirements whose text implies that kind of
// behaviour — not a real classifier, just enough signal to break ties
// between otherwise similarly-scored candidate elements.
const INTERFACE_CUES = ['interface', 'protocol', 'api', 'sends', 'receives', 'message', 'endpoint']
const RUNTIME_CUES = ['scheduling', 'real-time', 'realtime', 'deadline', 'latency', 'concurrent', 'timing']

function kindBias(requirementWords: Set<string>, kind: ArchitectureElementKind): number {
  if (kind === 'interface-spine' && INTERFACE_CUES.some((cue) => requirementWords.has(cue))) return 1
  if (kind === 'runtime' && RUNTIME_CUES.some((cue) => requirementWords.has(cue))) return 1
  return 0
}

function scoreRequirementAgainstElement(
  requirementWords: Set<string>,
  element: ArchitectureElement,
): number {
  const elementWords = significantWords(`${element.name} ${element.responsibility}`)
  let overlap = 0
  for (const word of requirementWords) {
    if (elementWords.has(word)) overlap++
  }
  return overlap + kindBias(requirementWords, element.kind)
}

// "Auto Allocate" (Area B, heuristic mode) — local, non-LLM keyword-overlap
// matching of unallocated requirements onto the *existing* architecture.
// Never creates elements (unlike autoConfigureAndAllocate above); requires
// at least one element to allocate onto. Requirements that don't score
// above the minimum threshold against any element are left unallocated
// rather than guessed at.
export function autoAllocateHeuristic(project: Project): AutoAllocateResult {
  const architecture = requireArchitecture(project)
  if (architecture.elements.length === 0) {
    throw new Error('Add at least one architecture element before running Auto Allocate')
  }
  const unallocated = project.requirements.filter((r) => !r.deletedAt && r.architectureElements.length === 0)

  const allocatedRequirementIds: string[] = []
  const unallocatedRequirementIds: string[] = []
  const MIN_SCORE = 1

  for (const requirement of unallocated) {
    const requirementWords = significantWords(
      requirement.allocationRationale
        ? `${requirement.text} ${requirement.allocationRationale}`
        : requirement.text,
    )
    let best: ArchitectureElement | null = null
    let bestScore = 0
    for (const element of architecture.elements) {
      const score = scoreRequirementAgainstElement(requirementWords, element)
      if (score > bestScore) {
        best = element
        bestScore = score
      }
    }
    if (best && bestScore >= MIN_SCORE) {
      addRequirementToElement(project, requirement.id, best.id)
      allocatedRequirementIds.push(requirement.id)
    } else {
      unallocatedRequirementIds.push(requirement.id)
    }
  }

  return { allocatedRequirementIds, unallocatedRequirementIds }
}

const AUTO_ALLOCATE_SYSTEM_PROMPT = `You are the Architect. Allocate each given requirement to the existing
architecture module that satisfies it. Do not propose any new modules — only
choose among the modules listed below.

Reply using exactly this line format, one per line, nothing else:

ALLOCATE: <requirement id>|<module name>
  <module name> must exactly match one of the existing module names below.
  Only allocate a requirement if you are reasonably confident which module
  covers it — omit its line entirely rather than guessing.

If none of the requirements can be confidently allocated, reply with the
single word: NONE.`

// Batch size for autoAllocateLlm's LLM calls — a large unallocated set (50+)
// sent to the model in one call risks it declining everything at once
// (output-length/attention pressure), so requirements are chunked and
// allocated across multiple smaller calls instead. Mirrors the per-file
// chunking rationale in codeImport.ts's proposeCodeGapRequirementsPerFile.
const AUTO_ALLOCATE_BATCH_SIZE = 20

// "Auto Allocate" (Area B, LLM mode) — same allocation-only scope as
// autoAllocateHeuristic, but via one or more LLM calls (batched, see
// AUTO_ALLOCATE_BATCH_SIZE) for higher-confidence matching. Reuses the
// existing ALLOCATE_LINE format/regex so both this and
// autoConfigureAndAllocate parse replies identically. The server route is a
// single request/response (no streaming), so batch progress isn't surfaced
// live to the UI today — batching still fixes wholesale-decline reliability
// even without a progress callback.
export async function autoAllocateLlm(
  project: Project,
  llmClient: LlmClient,
  llmOptions?: LlmCallOptions,
): Promise<AutoAllocateResult> {
  const architecture = requireArchitecture(project)
  if (architecture.elements.length === 0) {
    throw new Error('Add at least one architecture element before running Auto Allocate')
  }
  const unallocated = project.requirements.filter((r) => !r.deletedAt && r.architectureElements.length === 0)

  if (unallocated.length === 0) {
    return { allocatedRequirementIds: [], unallocatedRequirementIds: [] }
  }

  const byName = new Map(architecture.elements.map((e) => [e.name, e]))
  const allocatedRequirementIds: string[] = []
  const unallocatedIds = new Set(unallocated.map((r) => r.id))
  let usage: LlmUsage | undefined

  const totalBatches = Math.ceil(unallocated.length / AUTO_ALLOCATE_BATCH_SIZE)
  for (let i = 0; i < totalBatches; i++) {
    const batch = unallocated.slice(i * AUTO_ALLOCATE_BATCH_SIZE, (i + 1) * AUTO_ALLOCATE_BATCH_SIZE)

    const userPrompt = `Existing modules:\n${formatExistingModules(architecture.elements)}\n\nRequirements to allocate:\n${formatUnallocatedRequirements(batch)}`
    const messages = [
      { role: 'system' as const, content: AUTO_ALLOCATE_SYSTEM_PROMPT },
      { role: 'user' as const, content: userPrompt },
    ]
    const result = await llmClient.chat(messages, llmOptions)
    usage = addUsage(usage, result.usage)

    for (const m of result.content.matchAll(ALLOCATE_LINE)) {
      const requirementId = m[1].trim()
      const target = byName.get(m[2].trim())
      if (!target || !unallocatedIds.has(requirementId)) continue
      addRequirementToElement(project, requirementId, target.id)
      allocatedRequirementIds.push(requirementId)
      unallocatedIds.delete(requirementId)
    }
  }

  return {
    allocatedRequirementIds,
    unallocatedRequirementIds: Array.from(unallocatedIds),
    usage,
  }
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

export interface ChatWithArchitectResult {
  reply: string
  proposedElements: ProposedArchitectureElement[]
  proposedInterfaces: ProposedInterface[]
  usage?: LlmUsage
}

function extractProposedElements(reply: string): ProposedArchitectureElement[] {
  const proposals: ProposedArchitectureElement[] = []
  for (const m of reply.matchAll(MODULE_LINE)) {
    const kind = m[1].trim() as ArchitectureElementKind
    if (!VALID_MODULE_KINDS.has(kind)) continue
    proposals.push({ kind, layer: m[2].trim(), name: m[3].trim(), responsibility: m[4].trim() })
  }
  return proposals
}

function extractProposedInterfaces(reply: string): ProposedInterface[] {
  return Array.from(reply.matchAll(INTERFACE_LINE), (m) => ({ from: m[1].trim(), to: m[2].trim() }))
}

// Architect-chat path (mirrors chatWithAnalyst) — does not save anything.
// Proposed elements/interfaces are returned for the human to accept or
// discard; the caller invokes createArchitectureElement / acceptProposedInterface
// for each accepted proposal, keeping "resolution is always human" intact.
export async function chatWithArchitect(
  project: Project,
  llmClient: LlmClient,
  userMessage: string,
  llmOptions?: LlmCallOptions,
): Promise<ChatWithArchitectResult> {
  const architecture = requireArchitecture(project)
  const messages = buildArchitectChatMessages(architecture, userMessage)
  const result = await llmClient.chat(messages, llmOptions)
  return {
    reply: result.content,
    proposedElements: extractProposedElements(result.content),
    proposedInterfaces: extractProposedInterfaces(result.content),
    usage: result.usage,
  }
}

// Accepts a single proposed interface connection by element id (the UI
// resolves proposal module names to real element ids once both ends
// exist) — same push-if-absent semantics as autoConfigureAndAllocate's
// INTERFACE_LINE handling above.
export function acceptProposedInterface(
  project: Project,
  fromId: string,
  toId: string,
): ArchitectureElement {
  const architecture = requireArchitecture(project)
  const from = architecture.elements.find((e) => e.id === fromId)
  if (!from) {
    throw new Error(`Architecture element ${fromId} not found`)
  }
  if (!architecture.elements.some((e) => e.id === toId)) {
    throw new Error(`Architecture element ${toId} not found`)
  }
  if (!from.interfaces.includes(toId)) from.interfaces.push(toId)
  return from
}

// Inverse of acceptProposedInterface — removes a single interface
// connection (Interfaces list "Remove" action).
export function removeArchitectureInterface(
  project: Project,
  fromId: string,
  toId: string,
): ArchitectureElement {
  const architecture = requireArchitecture(project)
  const from = architecture.elements.find((e) => e.id === fromId)
  if (!from) {
    throw new Error(`Architecture element ${fromId} not found`)
  }
  from.interfaces = from.interfaces.filter((id) => id !== toId)
  return from
}

export interface CheckInterfaceConflictResult {
  conflict: ArchitectureConflict | null
  usage?: LlmUsage
}

// Scoped, non-persistent version of checkArchitectureConflicts for exactly
// one interface connection (Interfaces list "Check" action) — reuses the
// same mismatch/overlap prompt and parsing, but never writes into
// architecture.conflicts, which stays reserved for whole-architecture runs.
export async function checkInterfaceConflict(
  project: Project,
  llmClient: LlmClient,
  fromId: string,
  toId: string,
  llmOptions?: LlmCallOptions,
): Promise<CheckInterfaceConflictResult> {
  const architecture = requireArchitecture(project)
  const from = architecture.elements.find((e) => e.id === fromId)
  const to = architecture.elements.find((e) => e.id === toId)
  if (!from || !to) {
    throw new Error('Both architecture elements must exist to check their interface')
  }

  const messages = [
    { role: 'system' as const, content: ARCHITECTURE_CONFLICT_SYSTEM_PROMPT },
    { role: 'user' as const, content: formatElementList([from, to]) },
  ]
  const result = await llmClient.chat(messages, llmOptions)

  const mismatch = Array.from(result.content.matchAll(INTERFACE_MISMATCH_LINE)).find(
    (m) =>
      (m[1] === fromId && m[2] === toId) || (m[1] === toId && m[2] === fromId),
  )
  const overlap = Array.from(result.content.matchAll(OVERLAP_LINE)).find(
    (m) => (m[1] === fromId && m[2] === toId) || (m[1] === toId && m[2] === fromId),
  )

  const found = mismatch ?? overlap
  if (!found) return { conflict: null, usage: result.usage }

  const conflict: ArchitectureConflict = {
    id: 'CONF-scoped',
    kind: mismatch ? 'interface-mismatch' : 'overlapping-responsibility',
    elementIds: [found[1], found[2]],
    rationale: found[3].trim(),
  }
  return { conflict, usage: result.usage }
}

// Every connected element pair, deduplicated regardless of which side's
// `interfaces` array records the connection — a connection only needs to
// appear once in a pair's caller|callee direction to count.
// Exported so the Coding module (Area D) can scaffold a shared-interface
// subfolder for every connected pair, the same set Define Interfaces
// already iterates.
export function connectedPairs(elements: ArchitectureElement[]): Array<{ fromId: string; toId: string }> {
  const seen = new Set<string>()
  const pairs: Array<{ fromId: string; toId: string }> = []
  for (const element of elements) {
    for (const toId of element.interfaces) {
      const key = [element.id, toId].sort().join('|')
      if (seen.has(key)) continue
      seen.add(key)
      pairs.push({ fromId: element.id, toId })
    }
  }
  return pairs
}

const OPERATION_LINE = /^OPERATION:\s*([^|]+)\|\s*([^|]*)\|\s*([^|]*)\|\s*([^|]*)\|\s*(.*)$/gm

function parseOperations(reply: string): InterfaceContractOperation[] {
  return Array.from(reply.matchAll(OPERATION_LINE), (m) => ({
    name: m[1].trim(),
    description: m[2].trim(),
    request: m[3].trim(),
    response: m[4].trim(),
    errors: m[5].trim() === 'NONE' ? '' : m[5].trim(),
  }))
}

export interface DefineInterfaceContractResult {
  contract: InterfaceContract
  usage?: LlmUsage
}

// Defines (or redefines) the structured contract for a single interface
// connection — one LLM call per pair, asking the Architect to spell out the
// operations crossing it. Persists into architecture.interfaceContracts,
// replacing any existing entry for the same pair (order-independent).
export async function defineInterfaceContract(
  project: Project,
  llmClient: LlmClient,
  fromId: string,
  toId: string,
  llmOptions?: LlmCallOptions,
): Promise<DefineInterfaceContractResult> {
  const architecture = requireArchitecture(project)
  const from = architecture.elements.find((e) => e.id === fromId)
  const to = architecture.elements.find((e) => e.id === toId)
  if (!from || !to) {
    throw new Error('Both architecture elements must exist to define their interface')
  }

  const messages = [
    { role: 'system' as const, content: DEFINE_INTERFACE_CONTRACT_SYSTEM_PROMPT },
    { role: 'user' as const, content: formatElementList([from, to]) },
  ]
  const result = await llmClient.chat(messages, llmOptions)
  const operations = result.content.trim() === 'NONE' ? [] : parseOperations(result.content)

  const contract: InterfaceContract = { fromId, toId, operations, status: 'defined' }
  const existing = architecture.interfaceContracts ?? []
  const key = [fromId, toId].sort().join('|')
  architecture.interfaceContracts = [
    ...existing.filter((c) => [c.fromId, c.toId].sort().join('|') !== key),
    contract,
  ]
  return { contract, usage: result.usage }
}

export interface DefineAllInterfaceContractsResult {
  contracts: InterfaceContract[]
  usage?: LlmUsage
}

// "Define Interfaces" action bar button — runs defineInterfaceContract for
// every connected pair that doesn't already have a 'defined' contract,
// leaving already-defined contracts untouched (same non-destructive re-run
// behaviour as autoConfigureAndAllocate: topping up gaps, not redoing
// everything on every click).
export async function defineAllInterfaceContracts(
  project: Project,
  llmClient: LlmClient,
  llmOptions?: LlmCallOptions,
): Promise<DefineAllInterfaceContractsResult> {
  const architecture = requireArchitecture(project)
  const pairs = connectedPairs(architecture.elements)
  const defined = new Set(
    (architecture.interfaceContracts ?? [])
      .filter((c) => c.status === 'defined')
      .map((c) => [c.fromId, c.toId].sort().join('|')),
  )
  const pending = pairs.filter((p) => !defined.has([p.fromId, p.toId].sort().join('|')))

  let usage: LlmUsage | undefined
  for (const pair of pending) {
    const result = await defineInterfaceContract(project, llmClient, pair.fromId, pair.toId, llmOptions)
    usage = addUsage(usage, result.usage)
  }
  return { contracts: architecture.interfaceContracts ?? [], usage }
}

export interface CheckInterfacesResult {
  // Connected pairs with no contract at all, or whose contract has no
  // operations (the LLM found nothing to define, which usually means the
  // responsibility text is too vague to specify a contract from).
  undefinedPairs: Array<{ fromId: string; toId: string }>
  // Contracts whose status is 'stale' (endpoint responsibility text
  // changed since the contract was last defined).
  staleContracts: InterfaceContract[]
  complete: boolean
}

// "Check Interfaces" action bar button — a local, non-LLM pass over the
// current architecture verifying every connection has a real contract
// defined. Advisory only: unlike Check Conflicts this never blocks moving
// to a later phase, it just surfaces what Define Interfaces hasn't covered
// yet so the user can decide whether that's acceptable.
export function checkInterfaces(project: Project): CheckInterfacesResult {
  const architecture = requireArchitecture(project)
  const pairs = connectedPairs(architecture.elements)
  const contracts = architecture.interfaceContracts ?? []
  const contractByKey = new Map(contracts.map((c) => [[c.fromId, c.toId].sort().join('|'), c]))

  const undefinedPairs: Array<{ fromId: string; toId: string }> = []
  for (const pair of pairs) {
    const contract = contractByKey.get([pair.fromId, pair.toId].sort().join('|'))
    if (!contract || contract.status !== 'defined' || contract.operations.length === 0) {
      undefinedPairs.push(pair)
    }
  }
  const staleContracts = contracts.filter((c) => c.status === 'stale')

  return {
    undefinedPairs,
    staleContracts,
    complete: undefinedPairs.length === 0 && staleContracts.length === 0,
  }
}
