import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ensureHarnessElement, pruneOrphanedInterfaceReferences } from './architecture.js'
import { SCHEMA_VERSION, type Project, type ProjectMode } from './types.js'

const PROJECT_FILE = 'project.json'

// Pre-existing saved projects may have requirement.conflicts in the old
// string[] shape (bare other-requirement ids, no rationale text) from
// before Check Conflicts started persisting {requirementId, rationale}
// pairs. The rationale text for those old entries was never saved, so
// there's nothing meaningful to migrate it to — dropped on load rather
// than shown with a fabricated placeholder. conflictsCheckedAt is left
// unset for any requirement this touches, so the UI correctly shows "Not
// Run Yet" until the user re-runs Check Conflicts.
function dropLegacyConflictShape(project: Project): Project {
  for (const requirement of project.requirements) {
    const conflicts = requirement.conflicts as unknown
    if (Array.isArray(conflicts) && conflicts.length > 0 && typeof conflicts[0] === 'string') {
      requirement.conflicts = undefined
      requirement.conflictsCheckedAt = undefined
    }
  }
  return project
}

// Projects saved before projectMode/provenance existed have neither field —
// default to 'new'/'human' rather than leaving them undefined, since both
// are now non-optional on their respective types.
function applyLegacyDefaults(project: Project): Project {
  if (!project.projectMode) {
    project.projectMode = 'new'
  }
  // Persistent chat (ChatSession) landed after many projects already
  // existed; nothing was ever persisted before it, so there's nothing to
  // backfill — just normalise the field to [] so every call site can
  // .push/.find on it directly rather than guarding for undefined.
  if (!Array.isArray(project.chatSessions)) {
    project.chatSessions = []
  }
  for (const requirement of project.requirements) {
    if (!requirement.provenance) {
      requirement.provenance = 'human'
    }
  }
  // Architecture elements saved before elementInterfaces existed (the
  // per-element interface-contract feature) have no such field at all —
  // default to [] rather than leaving it undefined, since every call site
  // (seedElementInterface, markParticipantsMisaligned, etc.) assumes it's
  // always an array and calls .find/.push on it directly.
  if (project.architecture) {
    for (const element of project.architecture.elements) {
      if (!element.elementInterfaces) {
        element.elementInterfaces = []
      }
    }
    // Same gap for nextInterfaceSeq (added alongside interfaceDefinitions,
    // after some architectures were already created) — left undefined,
    // nextInterfaceId's `seq + 1` silently produces NaN, yielding ids like
    // "IFACE-NaN" instead of throwing. Seed it from the highest numeric
    // IFACE-NNN id already present (0 if none), so newly generated ids
    // continue the existing sequence instead of colliding/misordering.
    if (typeof project.architecture.nextInterfaceSeq !== 'number') {
      const existingSeqs = (project.architecture.interfaceDefinitions ?? [])
        .map((d) => Number(d.id.replace('IFACE-', '')))
        .filter((n) => Number.isFinite(n))
      project.architecture.nextInterfaceSeq = existingSeqs.length > 0 ? Math.max(...existingSeqs) + 1 : 1
    }
  }
  return project
}

// Pre-existing saved projects have requirement.architectureElement in the
// old single-value shape (string | null | undefined) from before the
// architectureElements array rename (element-based Coding migration,
// hide-not-delete). Converts it to the new architectureElements: string[]
// shape on load — a single prior allocation becomes a one-element array,
// null/undefined/missing becomes an empty array — and removes the legacy
// field so it doesn't linger alongside the new one. This is the one-time,
// behavior-preserving on-load migration the rename needs; nothing else
// about the old value's meaning changes (a requirement that was allocated
// to exactly one element still is, just expressed as [elementId] now).
function migrateArchitectureElementShape(project: Project): Project {
  for (const requirement of project.requirements) {
    const legacy = requirement as unknown as { architectureElement?: string | null }
    if ('architectureElement' in legacy) {
      const value = legacy.architectureElement
      requirement.architectureElements = value ? [value] : []
      delete legacy.architectureElement
    } else if (!Array.isArray(requirement.architectureElements)) {
      requirement.architectureElements = []
    }
  }
  return project
}

// Schema v1 -> v2 (project harness feature). Ensures any project that
// already has an architecture gains its single mandatory harness element;
// leaves project.platform and every InterfaceDefinition.declarations
// undefined (the user must pick a platform, and re-running Define
// Interfaces backfills declarations — neither is guessed here). Idempotent:
// a project already at v2 is returned untouched. ensureHarnessElement is
// itself idempotent, so re-running this is harmless.
function migrateToV2(project: Project): Project {
  if ((project.schemaVersion ?? 1) >= 2) return project
  if (project.architecture && !project.architecture.elements.some((e) => e.kind === 'harness')) {
    ensureHarnessElement(project)
  }
  project.schemaVersion = 2
  return project
}

// Schema v2 -> v3 (T4.2). Removes every interface reference left pointing at
// an element that no longer exists — interfaceDefinitions naming a deleted
// participant, every element's denormalised elementInterfaces copy of a
// since-removed definition, and stale element.interfaces graph edges. This
// is the repair half of the exact condition checkInterfaces already reports
// as danglingElementInterfaces; before this, deleteArchitectureElement never
// cleaned any of it up (Worm 2 carried IFACE entries for ARCH-002/006/007
// long after those elements were gone, which permanently blocked Coding and
// would permanently block the new architecture-phase readiness check).
// Idempotent — pruneOrphanedInterfaceReferences only ever removes references
// to ids that provably don't exist, so a clean project is untouched.
function migrateToV3(project: Project): Project {
  if ((project.schemaVersion ?? 1) >= 3) return project
  if (project.architecture) {
    const removed = pruneOrphanedInterfaceReferences(project.architecture)
    if (
      removed.removedDefinitionIds.length > 0 ||
      removed.clearedElementInterfaceRefs.length > 0 ||
      removed.removedGraphEdges.length > 0
    ) {
      console.warn(
        `[migrate v3] project ${project.id}: pruned orphaned interface refs — ` +
          `${removed.removedDefinitionIds.length} definition(s) [${removed.removedDefinitionIds.join(', ')}], ` +
          `${removed.clearedElementInterfaceRefs.length} element-interface copy(ies), ` +
          `${removed.removedGraphEdges.length} graph edge(s)`,
      )
    }
  }
  project.schemaVersion = 3
  return project
}

export interface ProjectStoreOptions {
  projectsRoot: string
}

// Filesystem-safe stamp for a new project's directory name, e.g.
// "My Project_2026-08-14_14-30-05" — human-readable on the shared drive
// (VIC is remote-only; several people browsing the same network share need
// to be able to tell projects apart by folder name alone) rather than an
// opaque UUID. Colons aren't valid in Windows/SMB paths, hence '-' in the
// time portion instead of ':'.
function timestampForDirName(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const datePart = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const timePart = `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  return `${datePart}_${timePart}`
}

// Strips characters invalid in Windows/SMB path segments (\/:*?"<>|),
// trims the result, and caps length so a very long project name can't
// produce an unwieldy or over-limit path once the timestamp is appended.
function sanitizeForDirName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '').trim()
  return (cleaned || 'project').slice(0, 80)
}

export class ProjectStore {
  private readonly projectsRoot: string

  constructor(options: ProjectStoreOptions) {
    this.projectsRoot = options.projectsRoot
  }

  // Public so callers outside the store (e.g. the Coding module's
  // subfolder scaffolding) can locate a project's directory to add sibling
  // content (a generated source tree) alongside project.json, without
  // duplicating the projectsRoot join logic.
  projectDir(id: string): string {
    return path.join(this.projectsRoot, id)
  }

  // Builds this project's on-disk directory name (which doubles as its
  // `id` — see createProject) from its display name and a timestamp,
  // guarding against two projects created in the same second under the
  // same name by appending a numeric suffix until the candidate directory
  // doesn't already exist.
  private async buildProjectDirName(name: string): Promise<string> {
    const base = `${sanitizeForDirName(name)}_${timestampForDirName(new Date())}`
    let candidate = base
    let suffix = 2
    while (await this.dirExists(candidate)) {
      candidate = `${base}-${suffix}`
      suffix += 1
    }
    return candidate
  }

  private async dirExists(dirName: string): Promise<boolean> {
    try {
      await stat(this.projectDir(dirName))
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw err
    }
  }

  async createProject(name: string, mode: ProjectMode = 'new'): Promise<Project> {
    const project: Project = {
      schemaVersion: SCHEMA_VERSION,
      id: await this.buildProjectDirName(name),
      name,
      projectMode: mode,
      requirements: [],
      // Initialised here (not left undefined) so a freshly created project
      // deep-equals what loadProject's normaliser produces — see
      // applyLegacyDefaults.
      chatSessions: [],
    }
    await this.saveProject(project)
    return project
  }

  async loadProject(id: string): Promise<Project> {
    const file = path.join(this.projectDir(id), PROJECT_FILE)
    const raw = await readFile(file, 'utf-8')
    return migrateToV3(
      migrateToV2(
        applyLegacyDefaults(migrateArchitectureElementShape(dropLegacyConflictShape(JSON.parse(raw) as Project))),
      ),
    )
  }

  async saveProject(project: Project): Promise<void> {
    const dir = this.projectDir(project.id)
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, PROJECT_FILE)
    await writeFile(file, JSON.stringify(project, null, 2), 'utf-8')
  }

  async renameProject(id: string, name: string): Promise<Project> {
    const project = await this.loadProject(id)
    project.name = name
    await this.saveProject(project)
    return project
  }

  // Deep-copies an existing project's whole directory (project.json + the
  // generated src/ tree) into a brand-new project directory, then applies
  // `mutate` to the clone (id + name are set by this method; `mutate` is for
  // everything else — platform, clearing derived state, etc.) and saves it.
  // Used by the "branch to a new project on platform change" flow (project
  // harness feature). The source project is left completely untouched.
  async copyProject(
    sourceId: string,
    newName: string,
    mutate?: (clone: Project) => void,
  ): Promise<Project> {
    const source = await this.loadProject(sourceId)
    const newId = await this.buildProjectDirName(newName)
    const sourceDir = this.projectDir(sourceId)
    const targetDir = this.projectDir(newId)
    // Copy the entire project directory first (brings src/ across), then
    // overwrite project.json with the mutated clone.
    await cp(sourceDir, targetDir, { recursive: true })
    const clone: Project = { ...structuredClone(source), id: newId, name: newName }
    mutate?.(clone)
    await this.saveProject(clone)
    return clone
  }

  async deleteProject(id: string): Promise<void> {
    await rm(this.projectDir(id), { recursive: true, force: true })
  }

  async listProjects(): Promise<Project[]> {
    let entries: string[]
    try {
      entries = await readdir(this.projectsRoot)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    const projects: Project[] = []
    for (const id of entries) {
      try {
        projects.push(await this.loadProject(id))
      } catch {
        // Not a valid project directory — skip it.
      }
    }
    return projects
  }
}
