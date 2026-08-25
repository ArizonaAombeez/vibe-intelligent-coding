import { findArchitectureType } from './architectureTypes.js'
import type { Architecture, ArchitectureElement, Project, Requirement, RequirementConflict } from './types.js'

// Mirrors packages/ui/src/api/types.ts's PhaseId — kept as a plain string
// union here rather than importing the UI package, per the UI-as-a-
// pluggable-module principle. Only 'requirements' and 'architecture' are
// exportable/importable today (backingKey is set); the rest are listed so
// the Import/Export UI can show every phase and grey out the ones with no
// data yet, without needing another round of wiring when they gain data.
export type ProjectPartId =
  | 'requirements'
  | 'architecture'
  | 'planning'
  | 'test-creation'
  | 'coding'
  | 'test-execution'

export interface ProjectPartInfo {
  id: ProjectPartId
  label: string
  // False for phases with no backing data to export/import yet.
  available: boolean
}

export const PROJECT_PARTS: ProjectPartInfo[] = [
  { id: 'requirements', label: 'Requirements', available: true },
  { id: 'architecture', label: 'Architecture', available: true },
  { id: 'planning', label: 'Planning', available: false },
  { id: 'test-creation', label: 'Test Creation', available: false },
  { id: 'coding', label: 'Coding', available: false },
  { id: 'test-execution', label: 'Test Execution', available: false },
]

// Everything in a part's export bundle needed to reconstruct it on import —
// each exported file is one of these, keyed by ProjectPartId.
export interface RequirementsPartData {
  requirements: Requirement[]
}

export interface ArchitecturePartData {
  architectureType: Project['architectureType']
  architecture: Architecture | null
}

// Only the two available parts have a concrete data shape — the rest are
// unreachable while ProjectPartInfo.available stays false for them.
export function exportPart(project: Project, partId: ProjectPartId): unknown {
  switch (partId) {
    case 'requirements':
      return {
        requirements: project.requirements,
      } satisfies RequirementsPartData
    case 'architecture':
      return {
        architectureType: project.architectureType ?? null,
        architecture: project.architecture ?? null,
      } satisfies ArchitecturePartData
    default:
      throw new Error(`Part "${partId}" has nothing to export yet`)
  }
}

const REQ_ID = /\bREQ-\d+\b/g
const IMPORTED_ID_PREFIX = 'IMP_'

// Appends "-2", "-3", ... to a candidate id until it no longer collides
// with anything in `taken` — importing the same export twice (or two
// exports whose source projects happened to number requirements/elements
// the same way) must never produce two live items sharing one id, since
// every lookup in this module finds by id.
function uniqueId(candidate: string, taken: Set<string>): string {
  if (!taken.has(candidate)) return candidate
  let n = 2
  while (taken.has(`${candidate}-${n}`)) n++
  return `${candidate}-${n}`
}

// Rewrites every REQ-NNN-shaped substring in free text to its IMP_REQ-NNN
// equivalent — catches references the source project's own prose made to
// its own requirements (e.g. an analyst note saying "see REQ-004"), which
// would otherwise silently point at an unrelated requirement (or nothing)
// once merged into a different project.
function remapRequirementReferencesInText(text: string, idMap: Map<string, string>): string {
  return text.replace(REQ_ID, (match) => idMap.get(match) ?? `${IMPORTED_ID_PREFIX}${match}`)
}

function remapConflicts(
  conflicts: RequirementConflict[] | undefined,
  idMap: Map<string, string>,
): RequirementConflict[] | undefined {
  if (!conflicts) return conflicts
  return conflicts.map((c) => ({
    ...c,
    requirementId: idMap.get(c.requirementId) ?? `${IMPORTED_ID_PREFIX}${c.requirementId}`,
    rationale: remapRequirementReferencesInText(c.rationale, idMap),
  }))
}

// Imports a previously-exported requirements part, merging it into the
// current project rather than replacing the existing list (Import/Export,
// resolved). Every imported requirement gets a fresh IMP_-prefixed id
// derived from its original one, so re-importing the same export twice (or
// importing exports from two different source projects) can never collide
// with each other or with the target project's own REQ-NNN ids. Any
// REQ-NNN-shaped reference inside the imported set — the requirement's own
// text, its conflicts[].requirementId, and its architectureElements (if any
// look like imported ids) — is rewritten in step, so cross-references stay
// internally consistent instead of quietly pointing at ids that mean
// something else (or nothing) in the target project.
export function importRequirementsFromPart(project: Project, data: RequirementsPartData): Requirement[] {
  const taken = new Set(project.requirements.map((r) => r.id))
  const idMap = new Map<string, string>()
  for (const requirement of data.requirements) {
    const newId = uniqueId(`${IMPORTED_ID_PREFIX}${requirement.id}`, taken)
    taken.add(newId)
    idMap.set(requirement.id, newId)
  }

  const imported: Requirement[] = data.requirements.map((source) => ({
    ...source,
    id: idMap.get(source.id)!,
    text: remapRequirementReferencesInText(source.text, idMap),
    analystNote: source.analystNote
      ? remapRequirementReferencesInText(source.analystNote, idMap)
      : source.analystNote,
    conflicts: remapConflicts(source.conflicts, idMap),
    // Imported architecture allocations refer to the source project's own
    // ARCH-NNN ids, which mean nothing here without also importing that
    // project's architecture — cleared rather than left pointing at a
    // block that doesn't exist (or a different one) in this project.
    architectureElements: [],
  }))

  project.requirements.push(...imported)
  return imported
}

const ARCH_ID = /\bARCH-\d+\b/g

function remapResponsibilityText(text: string, idMap: Map<string, string>): string {
  return text.replace(ARCH_ID, (match) => idMap.get(match) ?? `${IMPORTED_ID_PREFIX}${match}`)
}

// Imports a previously-exported architecture part, merging its layers and
// elements into the current project's architecture (creating one from the
// import if none exists yet). Element ids are remapped the same way
// requirement ids are (see importRequirementsFromPart) — every imported
// element gets an IMP_-prefixed id, and every ARCH-NNN reference inside the
// imported set (interfaces[], conflict elementIds) is rewritten in step, so
// an imported element can never silently point at a foreign or colliding id.
// Imported layer labels are appended after the project's existing layers;
// imported elements keep their original row/col, offset by however many
// layers already existed, so they land in the newly-appended rows rather
// than overlapping whatever the target project already has at row 0.
export function importArchitecturePart(project: Project, data: ArchitecturePartData): ArchitectureElement[] {
  if (!data.architecture) return []

  if (!project.architecture) {
    project.architecture = { layers: [], elements: [], nextElementSeq: 1, nextInterfaceSeq: 1 }
    if (!project.architectureType) {
      // The imported type id is external data (a previously-exported
      // architecture.json, possibly from an older tool version whose preset
      // list has since changed, or hand-edited) — never trusted blindly.
      // An id that no longer matches a known preset falls back to 'custom'
      // (always a valid preset, no default layers of its own) rather than
      // being stored as-is, which would otherwise leave the Architecture
      // screen's type selector unable to resolve it and silently hide the
      // whole action bar (Add element, Auto Configure, etc. are all gated
      // on a resolved type).
      project.architectureType =
        data.architectureType && findArchitectureType(data.architectureType) ? data.architectureType : 'custom'
    }
  }
  const architecture = project.architecture

  const rowOffset = architecture.layers.length
  architecture.layers.push(...data.architecture.layers)

  const taken = new Set(architecture.elements.map((e) => e.id))
  const idMap = new Map<string, string>()
  for (const element of data.architecture.elements) {
    const newId = uniqueId(`${IMPORTED_ID_PREFIX}${element.id}`, taken)
    taken.add(newId)
    idMap.set(element.id, newId)
  }

  const imported: ArchitectureElement[] = data.architecture.elements.map((source) => ({
    ...source,
    id: idMap.get(source.id)!,
    responsibility: remapResponsibilityText(source.responsibility, idMap),
    row: source.row === -1 ? source.row : source.row + rowOffset, // EXTERNAL_CONTEXT_ROW (-1) stays put — it's outside the layer grid
    interfaces: source.interfaces.map((id) => idMap.get(id) ?? `${IMPORTED_ID_PREFIX}${id}`),
    // Imported InterfaceDefinition-based master data isn't carried over by
    // this part import (only layers/elements are, per ArchitecturePartData)
    // — an imported element always starts with no local interface copies,
    // same as a freshly created one; the source project's own
    // interfaceDefinitions aren't part of this exported part.
    elementInterfaces: [],
  }))

  architecture.elements.push(...imported)
  return imported
}
