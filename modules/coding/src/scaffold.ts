import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { connectedPairs } from 'vic-requirements-elicitation'
import type { ArchitectureElement, Project } from 'vic-requirements-elicitation'

// One subfolder per architecture element (Area B/D, resolved) — the
// filesystem mechanism the write-scope isolation gate (scopeGate.ts)
// restricts writes to. Lives under <projectDir>/src/.
export const SOURCE_TREE_DIRNAME = 'src'
// Shared-interface pair subfolders: kept (deviation from this migration's
// original plan text, which called for deleting these) because
// modules/testing's TestCase interface-test file generation/execution
// (writeTestFiles.ts, executionScopeGate.ts) still depends on
// resolveAllowedScope's 2-element interface-pair branch resolving to a real
// subfolder here — TestCase.interfaceElementIds is a pre-existing,
// independent-of-Story feature the plan says stays untouched. Coding's own
// element-only path (runCoding.ts) simply no longer uses this branch.
export const SHARED_INTERFACES_DIRNAME = '_shared-interfaces'
// Exported (not module-private) so vic-testing can compute an element's
// marker file path without duplicating this filename constant — the
// per-element test command (Area F, resolved) lives in this same file,
// see readExistingMarkerExtras below.
export const MARKER_FILENAME = '.vic-element.json'

// Per-element fields this module doesn't itself set but must never clobber
// on a re-scaffold — currently just the Area F per-element test command
// (Test Execution reads/writes these via vic-testing's
// testCommandResolution.ts; scaffold.ts only needs to preserve them across
// its own idempotent marker rewrites).
interface MarkerExtras {
  testCommand?: string
  testArgs?: string[]
}

async function readExistingMarkerExtras(markerPath: string): Promise<MarkerExtras> {
  try {
    const raw = JSON.parse(await readFile(markerPath, 'utf-8'))
    const extras: MarkerExtras = {}
    if (typeof raw.testCommand === 'string') extras.testCommand = raw.testCommand
    if (Array.isArray(raw.testArgs) && raw.testArgs.every((a: unknown) => typeof a === 'string')) {
      extras.testArgs = raw.testArgs
    }
    return extras
  } catch {
    return {} // marker doesn't exist yet, or isn't valid JSON — nothing to preserve
  }
}

// Filesystem-safe slug: lowercase, non-alphanumerics collapse to single
// hyphens, no leading/trailing hyphen. Not prefixed with the element's
// ARCH-NNN id — the folder should read as the element's actual name (Area
// B's "gives the user clear visual/navigational separation" rationale) —
// the id is kept in the marker file for reverse lookup instead, guarding
// against this slug algorithm changing later.
export function elementSubfolderName(element: Pick<ArchitectureElement, 'name'>): string {
  const slug = element.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'element'
}

// Deterministic, order-independent slug for a 2-element interface's shared
// subfolder — sorting the two ids first means it doesn't matter which side
// of the connection a pair was recorded from. Kept for TestCase's
// interface-test file generation/execution (see the DIRNAME comment above).
export function sharedInterfaceSubfolderName(fromId: string, toId: string): string {
  return [fromId, toId].sort().join('__')
}

export interface ScaffoldResult {
  createdFolders: string[]
}

// Idempotent: safe to call before every Coding run (in case new elements
// were added since the last scaffold) — mkdir's recursive:true is itself
// idempotent, and marker files are overwritten with the same content each
// time rather than erroring if they already exist.
export async function scaffoldProjectSourceTree(project: Project, projectDir: string): Promise<ScaffoldResult> {
  if (!project.architecture) {
    throw new Error('Project has no architecture — select an Architecture type and add elements first')
  }
  const srcRoot = path.join(projectDir, SOURCE_TREE_DIRNAME)
  const createdFolders: string[] = []

  for (const element of project.architecture.elements) {
    const dirName = elementSubfolderName(element)
    const dir = path.join(srcRoot, dirName)
    const markerPath = path.join(dir, MARKER_FILENAME)
    await mkdir(dir, { recursive: true })
    const extras = await readExistingMarkerExtras(markerPath)
    await writeFile(
      markerPath,
      JSON.stringify({ architectureElementId: element.id, name: element.name, ...extras }, null, 2),
      'utf-8',
    )
    createdFolders.push(dirName)
  }

  // Shared-interface subfolders — still needed for TestCase's own
  // interface-pair scoping (see the SHARED_INTERFACES_DIRNAME comment
  // above); Coding itself no longer writes into these.
  for (const pair of connectedPairs(project.architecture.elements)) {
    const dirName = sharedInterfaceSubfolderName(pair.fromId, pair.toId)
    const dir = path.join(srcRoot, SHARED_INTERFACES_DIRNAME, dirName)
    const markerPath = path.join(dir, MARKER_FILENAME)
    await mkdir(dir, { recursive: true })
    const extras = await readExistingMarkerExtras(markerPath)
    await writeFile(
      markerPath,
      JSON.stringify({ fromId: pair.fromId, toId: pair.toId, ...extras }, null, 2),
      'utf-8',
    )
    createdFolders.push(path.join(SHARED_INTERFACES_DIRNAME, dirName))
  }

  return { createdFolders }
}

export function sourceTreeRoot(projectDir: string): string {
  return path.join(projectDir, SOURCE_TREE_DIRNAME)
}

// "Recode from scratch" support — deletes everything currently in an
// architecture element's own scoped subfolder (allowedRelativePrefix)
// before the agent runs again, so it writes fresh code instead of
// reviewing-and-possibly-keeping whatever's already there. Preserves the
// marker's testCommand/testArgs (Area F) the same way
// scaffoldProjectSourceTree's own idempotent rewrite does — a wipe must not
// silently lose Test Execution's saved per-element test command. No
// shared-scope conflict is possible anymore (Area B/D, resolved): a Coding
// run always targets exactly one element's own folder, so this function no
// longer needs any caller-side "does anything else share this subfolder"
// check before wiping.
export async function wipeScopedSubfolder(projectDir: string, allowedRelativePrefix: string): Promise<void> {
  const srcRoot = sourceTreeRoot(projectDir)
  const dir = path.join(srcRoot, allowedRelativePrefix)
  const markerPath = path.join(dir, MARKER_FILENAME)
  const extras = await readExistingMarkerExtras(markerPath)

  await rm(dir, { recursive: true, force: true })

  if (Object.keys(extras).length > 0) {
    // Re-seed just the preserved extras — scaffoldProjectSourceTree (called
    // by the caller right after this) will overwrite the rest of the
    // marker's own fields (architectureElementId/name, or fromId/toId)
    // unconditionally, same as its normal idempotent rewrite path.
    await mkdir(dir, { recursive: true })
    await writeFile(markerPath, JSON.stringify(extras, null, 2), 'utf-8')
  }
}
