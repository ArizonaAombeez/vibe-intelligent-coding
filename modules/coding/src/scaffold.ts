import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { connectedPairs } from 'vic-requirements-elicitation'
import type { ArchitectureElement, Project } from 'vic-requirements-elicitation'
import { withFsRetry } from './fsRetry.js'

const execFileAsync = promisify(execFile)

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

// EPERM/EBUSY/ENOTEMPTY/ENOENT retry belt-and-braces alongside
// clearHiddenAttribute below for whatever residual timing flakiness a
// mapped network drive (SMB) still has beyond the dotfile/Hidden issue that
// turned out to be this project's actual recurring EPERM cause (see
// clearHiddenAttribute). Local NTFS doesn't need this at all, but it's a
// harmless no-op retry loop when the op just succeeds on the first try. See
// fsRetry.ts for the shared implementation (also used by
// isolatedWorkspace.ts's merge-back step).
//
// EEXIST is handled separately, not via withFsRetry's shared retryable-code
// set: recursive:true mkdir is supposed to silently succeed if the target
// already exists as a directory, and on a real run this genuinely does mean
// "already there, nothing to do" — e.g. a second mkdir call racing the SMB
// client's own directory-listing cache still catching up on whether the
// path it just created server-side is visible yet (the mirror image of the
// ENOENT case above: instead of a just-created path looking absent, a
// path Node itself just created — or the server already had — surfaces as
// "already exists" on a follow-up create attempt for the same reason).
// Retrying EEXIST through withFsRetry would be wrong for rm/rename (a
// caller that unexpectedly finds something already at a destination it
// expected to be clear needs to know, not silently proceed) — this handles
// it only here, where "already exists" is unambiguously fine.
async function mkdirWithRetry(dirPath: string): Promise<void> {
  try {
    await withFsRetry(() => mkdir(dirPath, { recursive: true }))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    // Confirm it's actually a directory already there, not some other
    // file unexpectedly occupying this path — swallowing EEXIST should
    // never mask a real conflict, only the benign "already a directory"
    // case recursive:true is supposed to handle itself.
    const existing = await stat(dirPath)
    if (!existing.isDirectory()) throw err
  }
}

// VIC's project storage is commonly a mapped SMB/Samba network drive (see
// PROJECTS_ROOT in packages/server/src/index.ts). Samba shares frequently
// default to "hide dot files = yes", so the server stamps the Windows Hidden
// attribute onto every dotfile it serves — MARKER_FILENAME
// ('.vic-element.json') included — and keeps re-imposing it even after a
// client clears it locally (verified on this project's actual share).
// Clearing it isn't confirmed to be *the* fix for the EPERM this project has
// hit (a standalone write against the live problem file succeeded without
// this), but it's a real, idempotent, cheap precondition to rule out before
// looking elsewhere, and does no harm on a share/OS where there's nothing to
// clear. best-effort only (swallow failures): a local NTFS project
// directory has no such attribute, and `attrib` on a not-yet-existing file
// (first-ever write for this element) is expected to fail harmlessly.
async function clearHiddenAttribute(filePath: string): Promise<void> {
  if (process.platform !== 'win32') return
  try {
    await execFileAsync('attrib', ['-h', filePath])
  } catch {
    // Nothing to clear (file doesn't exist yet) or attrib itself unavailable
    // — either way, fall through and let the write attempt surface any real
    // problem on its own.
  }
}

async function writeFileWithRetry(filePath: string, data: string): Promise<void> {
  await clearHiddenAttribute(filePath)
  try {
    await withFsRetry(() => writeFile(filePath, data, 'utf-8'))
  } catch (err) {
    // Diagnostic only (Code All's EPERM on this file has recurred and
    // wasn't reproducible standalone) — logs enough to tell, next time it
    // happens live, whether it's really EPERM/EBUSY exhausting every retry
    // vs. some other error code masquerading the same way in the UI.
    console.error(
      `[scaffold] writeFileWithRetry failed for ${filePath}:`,
      (err as NodeJS.ErrnoException).code,
      (err as Error).message,
    )
    throw err
  }
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
    await mkdirWithRetry(dir)
    const extras = await readExistingMarkerExtras(markerPath)
    await writeFileWithRetry(
      markerPath,
      JSON.stringify({ architectureElementId: element.id, name: element.name, ...extras }, null, 2),
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
    await mkdirWithRetry(dir)
    const extras = await readExistingMarkerExtras(markerPath)
    await writeFileWithRetry(
      markerPath,
      JSON.stringify({ fromId: pair.fromId, toId: pair.toId, ...extras }, null, 2),
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

  // Deleting a populated directory IN PLACE on a network share (SMB) has
  // proven fundamentally unreliable here — every one of EPERM/EBUSY/
  // ENOTEMPTY/ENOENT has been observed from a direct rm(dir, {recursive}) or
  // the mkdir that immediately follows it, each a different symptom of the
  // same root cause: rm has to walk and remove real content while the SMB
  // client's own directory-state cache and the server can transiently
  // disagree about what's there, and a plain rm gives it nothing to fall
  // back on when that happens mid-walk. Retrying the same in-place rm (the
  // old approach) just retries into the same race.
  //
  // Renaming the directory out of the way first sidesteps this: rename() is
  // a single metadata operation (no content is walked or touched), so it
  // either succeeds cleanly or fails cleanly — no partial-delete state is
  // possible. The actual content removal then happens on a disposal path
  // nothing else references, is retried the same way, and — critically — is
  // NOT allowed to fail this function: by the time the rename succeeds, the
  // real path is already gone from the caller's perspective (which is all
  // wipeScopedSubfolder actually promises), so a stuck disposal delete
  // becomes a harmless leftover folder under a disposal name rather than a
  // blocking error surfaced to the user mid-recode.
  const disposalDir = `${dir}.vic-disposed-${Date.now()}`
  const dirExisted = await stat(dir).then(
    () => true,
    () => false,
  )
  if (dirExisted) {
    await withFsRetry(() => rename(dir, disposalDir))
    await withFsRetry(() => rm(disposalDir, { recursive: true, force: true })).catch((err) => {
      console.error(`[scaffold] failed to remove disposed folder ${disposalDir} (non-fatal, wipe already succeeded):`, err)
    })
  }

  if (Object.keys(extras).length > 0) {
    // Re-seed just the preserved extras — scaffoldProjectSourceTree (called
    // by the caller right after this) will overwrite the rest of the
    // marker's own fields (architectureElementId/name, or fromId/toId)
    // unconditionally, same as its normal idempotent rewrite path.
    await mkdirWithRetry(dir)
    await writeFileWithRetry(markerPath, JSON.stringify(extras, null, 2))
  }
}
