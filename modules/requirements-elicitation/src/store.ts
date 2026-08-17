import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
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
  for (const requirement of project.requirements) {
    if (!requirement.provenance) {
      requirement.provenance = 'human'
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
    }
    await this.saveProject(project)
    return project
  }

  async loadProject(id: string): Promise<Project> {
    const file = path.join(this.projectDir(id), PROJECT_FILE)
    const raw = await readFile(file, 'utf-8')
    return applyLegacyDefaults(migrateArchitectureElementShape(dropLegacyConflictShape(JSON.parse(raw) as Project)))
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
