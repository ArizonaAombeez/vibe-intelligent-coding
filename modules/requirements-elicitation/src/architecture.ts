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
  ElementInterfaceDefinition,
  IncompleteOperation,
  InterfaceDefinition,
  InterfaceContractOperation,
  InterfaceRole,
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
    nextInterfaceSeq: 1,
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
    elementInterfaces: [],
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

MODULE: <kind>|<layer>|<name>|<responsibility>
  kind is one of: functional, service, interface-spine, runtime, external
  layer is one of the layers listed above, or the word NONE for an
  external module (external modules are not placed on a layer).
  responsibility should be one or two sentences, concrete enough to later
  infer what data/calls cross this module's interfaces from it alone (what
  it owns, what it reads or receives, what it produces or reports) — not
  just a category label.

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

// "Auto Allocate" (Area B, LLM mode) — allocates unallocated requirements
// onto the *existing* architecture (never creates elements, unlike
// autoConfigureAndAllocate above) via one or more LLM calls (batched, see
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
// INTERFACE_LINE handling above. Only touches the raw connectivity graph
// (element.interfaces) — a covering InterfaceDefinition is created/edited
// separately via defineInterfaceDefinition/setInterfaceDefinition.
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

// The trailing range/resolution/unit/update-frequency fields (Area B,
// interface data-contract requirement) are optional on the line itself —
// captured only when the Architect's reply includes them — so a reply still
// using the older 5-field OPERATION format (name|description|request|
// response|errors) parses exactly as it always did, just with the new
// fields left undefined rather than failing to match.
const OPERATION_LINE =
  /^OPERATION:\s*([^|\n]+)\|\s*([^|\n]*)\|\s*([^|\n]*)\|\s*([^|\n]*)\|\s*([^|\n]*)(?:\|\s*([^|\n]*)\|\s*([^|\n]*)\|\s*([^|\n]*)\|\s*([^|\n]*))?$/gm

// Distinguishes "the Architect considered this field and it doesn't apply"
// (the reply literally said NONE, e.g. a login RPC has no physical unit)
// from "this field was never answered at all" (undefined — only possible
// via the older 5-field OPERATION line, which has no trailing group to
// capture at all). checkInterfaces' completeness check treats an explicit
// 'N/A' as satisfied, since the Architect made a real judgement call on it;
// only true undefined counts as an incomplete gap.
function noneToNA(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (value === undefined) return undefined
  return !trimmed || trimmed === 'NONE' ? 'N/A' : trimmed
}

function parseOperations(reply: string): InterfaceContractOperation[] {
  return Array.from(reply.matchAll(OPERATION_LINE), (m) => {
    const updateFrequencyField = m[9]?.trim()
    const drivenDirectly = updateFrequencyField === 'DRIVEN' ? true : undefined
    return {
      name: m[1].trim(),
      description: m[2].trim(),
      request: m[3].trim(),
      response: m[4].trim(),
      errors: m[5].trim() === 'NONE' ? '' : m[5].trim(),
      range: noneToNA(m[6]),
      resolution: noneToNA(m[7]),
      unit: noneToNA(m[8]),
      updateFrequency: drivenDirectly ? undefined : noneToNA(updateFrequencyField),
      drivenDirectly,
    }
  })
}

// Finds the InterfaceDefinition (if any) whose participants cover both
// ends of a pair — the coverage lookup every pairwise-facing function below
// needs, now that a definition can have more than 2 participants.
function findDefinitionForPair(architecture: Architecture, fromId: string, toId: string): InterfaceDefinition | undefined {
  return (architecture.interfaceDefinitions ?? []).find(
    (d) => d.participants.some((p) => p.elementId === fromId) && d.participants.some((p) => p.elementId === toId),
  )
}

// Every participant element's own ElementInterfaceDefinition entry for a
// given master definition, resolved to the live element records.
function participantElements(architecture: Architecture, definition: InterfaceDefinition): ArchitectureElement[] {
  const ids = new Set(definition.participants.map((p) => p.elementId))
  return architecture.elements.filter((e) => ids.has(e.id))
}

// Seeds/updates one participant element's own local copy to mirror the
// master definition it belongs to — called whenever a definition's
// operations or participant set changes. Every OTHER participant is marked
// misaligned in the same pass (markParticipantsMisaligned below); this one
// (the element whose operations were just authored through
// defineInterfaceDefinition/setInterfaceDefinition) is seeded aligned,
// since its copy was just made to match by construction.
function seedElementInterface(
  element: ArchitectureElement,
  definition: InterfaceDefinition,
  role: InterfaceRole,
): void {
  const existing = element.elementInterfaces.find((ei) => ei.masterDefinitionId === definition.id)
  const entry: ElementInterfaceDefinition = {
    masterDefinitionId: definition.id,
    role,
    operations: definition.operations.map((op) => ({ ...op })),
    aligned: true,
    reqsCheckedAt: existing?.reqsCheckedAt,
  }
  if (existing) {
    Object.assign(existing, entry)
  } else {
    element.elementInterfaces.push(entry)
  }
}

// The hard-block trigger (Area B/D, resolved): the instant a master
// definition's operations or participant set changes, every OTHER
// participant's own copy is immediately flagged aligned:false — not
// lazily recomputed later. Coding's interfaceGateReasonForElement refuses
// to run for any element with an aligned:false entry until a human
// reconciles it (updates its own operations copy via
// reconcileElementInterface below).
function markParticipantsMisaligned(architecture: Architecture, definition: InterfaceDefinition, exceptElementId?: string): void {
  for (const element of participantElements(architecture, definition)) {
    if (element.id === exceptElementId) continue
    const entry = element.elementInterfaces.find((ei) => ei.masterDefinitionId === definition.id)
    if (entry) {
      entry.aligned = false
    } else {
      const participant = definition.participants.find((p) => p.elementId === element.id)
      element.elementInterfaces.push({
        masterDefinitionId: definition.id,
        role: participant?.role ?? 'both',
        operations: [],
        aligned: false,
      })
    }
  }
}

export interface DefineInterfaceDefinitionResult {
  definition: InterfaceDefinition
  usage?: LlmUsage
}

// Shared persistence for both the LLM-authored path
// (defineInterfaceDefinition) and the manual path (setInterfaceDefinition
// below) — replaces any existing definition with the same id, or appends a
// new one. Stamps updatedAt and marks every other participant misaligned
// (the author's own element, if it's a participant, is seeded aligned by
// the caller via seedElementInterface).
function persistInterfaceDefinition(
  project: Project,
  architecture: Architecture,
  definition: InterfaceDefinition,
  authoredByElementId?: string,
): void {
  definition.updatedAt = new Date().toISOString()
  const existing = architecture.interfaceDefinitions ?? []
  architecture.interfaceDefinitions = [...existing.filter((d) => d.id !== definition.id), definition]

  if (authoredByElementId) {
    const authorRole = definition.participants.find((p) => p.elementId === authoredByElementId)?.role ?? 'both'
    const author = architecture.elements.find((e) => e.id === authoredByElementId)
    if (author) seedElementInterface(author, definition, authorRole)
  }
  markParticipantsMisaligned(architecture, definition, authoredByElementId)
  void project
}

function nextInterfaceId(architecture: Architecture): string {
  // Defensive against nextInterfaceSeq being missing/non-numeric on this
  // architecture object, regardless of why — store.ts's applyLegacyDefaults
  // backfills it on load for projects saved before the field existed, but
  // that guard only runs once per load; relying on every caller to have
  // gone through it first is exactly the fragile invariant that produced a
  // real "IFACE-undefined" id in an existing project (String(undefined)
  // padStart'd), which then broke prompt rendering for any element
  // participating in that interface (see buildCodingPrompt's
  // otherParticipantNames, which can't find a definition by that id).
  // Falling back to a "highest existing IFACE-NNN id + 1" scan mirrors
  // applyLegacyDefaults's own repair logic, so a bad seq self-heals here
  // too instead of only being fixed at load time.
  const seq =
    typeof architecture.nextInterfaceSeq === 'number' && Number.isFinite(architecture.nextInterfaceSeq)
      ? architecture.nextInterfaceSeq
      : (() => {
          const existingSeqs = (architecture.interfaceDefinitions ?? [])
            .map((d) => Number(d.id.replace('IFACE-', '')))
            .filter((n) => Number.isFinite(n))
          return existingSeqs.length > 0 ? Math.max(...existingSeqs) + 1 : 1
        })()
  architecture.nextInterfaceSeq = seq + 1
  return `IFACE-${String(seq).padStart(3, '0')}`
}

// Defines (or redefines) the structured master definition for a single
// interface connection — one LLM call per pair, asking the Architect to
// spell out the operations crossing it. Persists into
// architecture.interfaceDefinitions, replacing any existing definition
// covering this pair (creating a new 2-participant, both/both-role
// definition if none exists yet).
export async function defineInterfaceDefinition(
  project: Project,
  llmClient: LlmClient,
  fromId: string,
  toId: string,
  llmOptions?: LlmCallOptions,
): Promise<DefineInterfaceDefinitionResult> {
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

  const existing = findDefinitionForPair(architecture, fromId, toId)
  const definition: InterfaceDefinition = existing
    ? { ...existing, operations, status: 'defined' }
    : {
        id: nextInterfaceId(architecture),
        name: `${from.name} ↔ ${to.name}`,
        participants: [
          { elementId: fromId, role: 'both' },
          { elementId: toId, role: 'both' },
        ],
        operations,
        status: 'defined',
        updatedAt: '',
      }
  persistInterfaceDefinition(project, architecture, definition)
  // Both sides are seeded aligned here (unlike the single-author case in
  // setInterfaceDefinition) since the Architect authored both sides at once
  // — there is no single "other participant" to leave misaligned.
  for (const p of definition.participants) {
    const element = architecture.elements.find((e) => e.id === p.elementId)
    if (element) seedElementInterface(element, definition, p.role)
  }
  return { definition, usage: result.usage }
}

// Manual counterpart to defineInterfaceDefinition — the human (Architect
// persona's user) directly authors the participant list and operations for
// one interface rather than asking the LLM, for the "list and edit all
// interfaces" requirement (global + per-element manual CRUD). Same
// persistence behaviour: replaces any existing definition with this id, or
// creates a new one. Every participant must already exist AND already be
// graph-connected (element.interfaces) to at least one other participant —
// this only edits/creates the definition, it never creates the connection
// itself (use acceptProposedInterface/manual element edit for that).
export function setInterfaceDefinition(
  project: Project,
  definitionId: string | undefined,
  name: string,
  participants: Array<{ elementId: string; role: InterfaceRole }>,
  operations: InterfaceContractOperation[],
): InterfaceDefinition {
  const architecture = requireArchitecture(project)
  if (participants.length < 2) {
    throw new Error('An interface definition needs at least 2 participants')
  }
  for (const p of participants) {
    if (!architecture.elements.some((e) => e.id === p.elementId)) {
      throw new Error(`Architecture element ${p.elementId} not found`)
    }
  }
  const participantIds = new Set(participants.map((p) => p.elementId))
  const anyConnected = participants.some((p) => {
    const element = architecture.elements.find((e) => e.id === p.elementId)!
    return element.interfaces.some((id) => participantIds.has(id))
  })
  if (!anyConnected) {
    throw new Error('These elements are not connected — add the interface connection first')
  }

  const definition: InterfaceDefinition = {
    id: definitionId ?? nextInterfaceId(architecture),
    name,
    participants,
    operations,
    status: 'defined',
    updatedAt: '',
  }
  persistInterfaceDefinition(project, architecture, definition)
  // The human authoring this form is editing every participant's shared
  // understanding at once (unlike reconcileElementInterface, which edits
  // just one element's own copy) — seed every participant aligned, same as
  // the LLM path above.
  for (const p of participants) {
    const element = architecture.elements.find((e) => e.id === p.elementId)
    if (element) seedElementInterface(element, definition, p.role)
  }
  return definition
}

// Reconciles one element's own local interface copy against its current
// master definition — the human review step required before Coding
// unblocks for that element (Area B/D, resolved: a master change hard-
// blocks every participant until reviewed against that element's own
// requirements and updated to match). Flips aligned back to true and
// stamps reqsCheckedAt. Does not touch the master definition itself or any
// other participant's copy.
export function reconcileElementInterface(
  project: Project,
  elementId: string,
  masterDefinitionId: string,
  operations: InterfaceContractOperation[],
): ElementInterfaceDefinition {
  const architecture = requireArchitecture(project)
  const element = architecture.elements.find((e) => e.id === elementId)
  if (!element) {
    throw new Error(`Architecture element ${elementId} not found`)
  }
  const entry = element.elementInterfaces.find((ei) => ei.masterDefinitionId === masterDefinitionId)
  if (!entry) {
    throw new Error(`${elementId} does not participate in interface ${masterDefinitionId}`)
  }
  entry.operations = operations
  entry.aligned = true
  entry.reqsCheckedAt = new Date().toISOString()
  return entry
}

export interface DefineAllInterfaceDefinitionsResult {
  definitions: InterfaceDefinition[]
  usage?: LlmUsage
}

// "Define Interfaces" action bar button — runs defineInterfaceDefinition for
// every connected pair not already covered by a 'defined' definition,
// leaving already-defined ones untouched (same non-destructive re-run
// behaviour as autoConfigureAndAllocate: topping up gaps, not redoing
// everything on every click). Pass force:true (the "Redefine All
// Interfaces" action bar button) to instead re-ask the Architect for every
// connected pair regardless of existing status — the bulk equivalent of the
// per-interface "Redefine" action, needed e.g. to backfill new contract
// fields (range/resolution/unit/update-frequency) onto definitions that
// were defined before those fields existed. Only ever produces/tops-up
// 2-participant definitions — consolidating multiple pairwise definitions
// into one N-ary shared definition is a manual UI action, not automated.
export async function defineAllInterfaceDefinitions(
  project: Project,
  llmClient: LlmClient,
  llmOptions?: LlmCallOptions,
  force = false,
): Promise<DefineAllInterfaceDefinitionsResult> {
  const architecture = requireArchitecture(project)
  const pairs = connectedPairs(architecture.elements)
  const pending = force
    ? pairs
    : pairs.filter((p) => {
        const definition = findDefinitionForPair(architecture, p.fromId, p.toId)
        return !definition || definition.status !== 'defined'
      })

  let usage: LlmUsage | undefined
  for (const pair of pending) {
    const result = await defineInterfaceDefinition(project, llmClient, pair.fromId, pair.toId, llmOptions)
    usage = addUsage(usage, result.usage)
  }
  return { definitions: architecture.interfaceDefinitions ?? [], usage }
}

export interface CheckInterfacesResult {
  // Connected pairs with no covering definition at all, or whose
  // definition has no operations (the LLM found nothing to define, which
  // usually means the responsibility text is too vague to specify a
  // definition from).
  undefinedPairs: Array<{ fromId: string; toId: string }>
  // Definitions whose status is 'stale' (a participant's responsibility
  // text changed since this definition was last defined).
  staleContracts: InterfaceDefinition[]
  // Operations on an otherwise-'defined' definition that are missing
  // range/resolution/unit, or missing both updateFrequency and
  // drivenDirectly (Area B, interface data-contract requirement) — distinct
  // from undefinedPairs, which has no definition/operations to inspect at
  // all.
  incompleteOperations: IncompleteOperation[]
  // Elements with at least one aligned:false entry — flagged the instant a
  // master definition they participate in changes, until a human
  // reconciles that element's own copy (reconcileElementInterface). Hard
  // blocks Coding for that element (see interfaceGateReasonForElement in
  // modules/coding).
  misalignedElements: Array<{ elementId: string; masterDefinitionId: string }>
  // Elements with an elementInterfaces entry whose masterDefinitionId does
  // not match any real definition in architecture.interfaceDefinitions — a
  // dangling reference, distinct from misalignment (aligned can be true on
  // a dangling entry, since alignment only tracks staleness against a
  // master that DOES exist). This shape is reachable from historical data:
  // nextInterfaceId used to silently generate "IFACE-undefined" if
  // nextInterfaceSeq was ever missing/non-numeric on an older project (see
  // its own comment and store.ts's applyLegacyDefaults migration, which
  // only repairs the counter going forward, not any id already generated
  // wrong and persisted). Surfaced with the same hard-block treatment as
  // misalignment (see interfaceGateReasonForElement) since there is no
  // "operations" content to fall back on for a definition that doesn't
  // exist at all — a human must re-author or remove the connection.
  danglingElementInterfaces: Array<{ elementId: string; masterDefinitionId: string }>
  complete: boolean
}

function missingDataContractFields(op: InterfaceContractOperation): string[] {
  const missing: string[] = []
  if (!op.range) missing.push('range')
  if (!op.resolution) missing.push('resolution')
  if (!op.unit) missing.push('unit')
  if (!op.updateFrequency && !op.drivenDirectly) missing.push('update frequency (or driven-directly)')
  return missing
}

// "Check Interfaces" action bar button — a local, non-LLM pass over the
// current architecture verifying every connection is covered by a real
// definition, that each defined operation's data-contract detail
// (range/resolution/unit/update-frequency) is fully specified, and that
// every participant's own local copy is still aligned with its master.
// Detection only, mirroring the Architecture-level conflict-check pattern
// for undefinedPairs/incompleteOperations (resolution is always human) —
// but misalignedElements is also read directly by Coding's hard gate
// (interfaceGateReasonForElement, Area D), not just advisory.
export function checkInterfaces(project: Project): CheckInterfacesResult {
  const architecture = requireArchitecture(project)
  const pairs = connectedPairs(architecture.elements)
  const definitions = architecture.interfaceDefinitions ?? []

  const undefinedPairs: Array<{ fromId: string; toId: string }> = []
  const incompleteOperations: IncompleteOperation[] = []
  for (const pair of pairs) {
    const definition = findDefinitionForPair(architecture, pair.fromId, pair.toId)
    if (!definition || definition.status !== 'defined' || definition.operations.length === 0) {
      undefinedPairs.push(pair)
      continue
    }
    for (const op of definition.operations) {
      const missingFields = missingDataContractFields(op)
      if (missingFields.length > 0) {
        incompleteOperations.push({ fromId: pair.fromId, toId: pair.toId, operationName: op.name, missingFields })
      }
    }
  }
  const staleContracts = definitions.filter((d) => d.status === 'stale')

  const definitionIds = new Set(definitions.map((d) => d.id))
  const misalignedElements: Array<{ elementId: string; masterDefinitionId: string }> = []
  const danglingElementInterfaces: Array<{ elementId: string; masterDefinitionId: string }> = []
  for (const element of architecture.elements) {
    for (const entry of element.elementInterfaces) {
      if (!definitionIds.has(entry.masterDefinitionId)) {
        danglingElementInterfaces.push({ elementId: element.id, masterDefinitionId: entry.masterDefinitionId })
        continue
      }
      if (!entry.aligned) misalignedElements.push({ elementId: element.id, masterDefinitionId: entry.masterDefinitionId })
    }
  }

  return {
    undefinedPairs,
    staleContracts,
    incompleteOperations,
    misalignedElements,
    danglingElementInterfaces,
    complete:
      undefinedPairs.length === 0 &&
      staleContracts.length === 0 &&
      incompleteOperations.length === 0 &&
      misalignedElements.length === 0 &&
      danglingElementInterfaces.length === 0,
  }
}
