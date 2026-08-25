import { cp, mkdtemp, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { withFsRetry } from './fsRetry.js'
import { sourceTreeRoot } from './scaffold.js'

// Every filesystem operation a single Coding run performs against srcRoot
// (scaffoldProjectSourceTree's mkdir/write, wipeScopedSubfolder's wipe,
// withIsolatedElementWorkspace's copy-out and rename-based merge-back,
// gitInitIfNeeded/gitCommitAll) used to run DIRECTLY against
// Q:\VIC_Data\<project>\src — a network share. Every one of those
// operations has independently produced a real, reproducible SMB error
// (ENOTEMPTY, EBUSY, ENOENT, EEXIST, EPERM/unlink) on this project's
// share, each a different symptom of the same underlying cause: SMB
// directory-state consistency (the client's own cache vs. the server) is
// just not reliable enough for the volume of small, rapid create/delete/
// rename calls one Coding run makes. Retrying each individual call only
// narrows the race window; it doesn't remove it, which is why a new errno
// kept surfacing every time a previously-unexercised call site got hit.
//
// This module removes the bug class instead of chasing further symptoms:
// a Coding run's entire src/ tree churn now happens on LOCAL disk (which
// doesn't have SMB's consistency issues at all), with exactly two
// network-touching operations per run — one recursive copy down at the
// start, one recursive copy up at the end — instead of dozens of
// individual mkdir/rm/rename calls scattered across the run. Every other
// route that reads Q:\...\src directly between runs (Analyze Code, Test
// Execution, code-gap-scan, etc.) is unaffected: Q:\ remains the single
// authoritative copy at rest, this only takes it temporarily private for
// the duration of one run.

export interface LocalSourceTreeSession {
  // A throwaway local directory standing in for the project's real
  // (network) projectDir for the duration of one Coding run — pass this
  // wherever the run previously passed the real projectDir (e.g.
  // scaffoldProjectSourceTree(project, localProjectDir)), so every
  // internal sourceTreeRoot(projectDir) call already resolves to
  // localSrcRoot below without scaffold.ts needing to know about any of
  // this.
  localProjectDir: string
  // localProjectDir's own 'src' subdirectory — equivalent to what
  // sourceTreeRoot(localProjectDir) would compute, exposed directly so
  // callers that already operate on srcRoot (gitInitIfNeeded,
  // withIsolatedElementWorkspace, gitCommitAll) don't need to re-derive it.
  localSrcRoot: string
  // Copies localSrcRoot back over the real srcRoot and disposes of the
  // local working copy. Must be called before the run returns on every
  // path that could have written anything — the caller is responsible for
  // calling this in a `finally` (see runCoding.ts).
  syncBackAndDispose(): Promise<void>
}

// Copies the real (network) srcRoot down to a fresh local temp directory,
// creating srcRoot itself (mkdir, not copy) if it doesn't exist yet — a
// project's very first Coding run has no src/ tree on disk yet, so there's
// nothing to copy down; the local copy just starts empty, same as
// scaffoldProjectSourceTree would have found it.
export async function openLocalSourceTree(srcRoot: string): Promise<LocalSourceTreeSession> {
  const localProjectDir = await mkdtemp(path.join(tmpdir(), 'vic-src-'))
  const localSrcRoot = sourceTreeRoot(localProjectDir)
  const exists = await stat(srcRoot).then(
    () => true,
    () => false,
  )
  if (exists) {
    // Retried for the same reason every other network-touching call in
    // this file is: a real EPERM ("copyfile" on what should be a directory
    // path) was observed here in practice, consistent with the SMB
    // client's stat()/directory-listing cache being transiently stale
    // about srcRoot's contents mid-copy — the read-side mirror of the
    // write-side races withFsRetry already covers everywhere else. This is
    // one of only two real-network operations this whole module performs
    // (the other being the sync-back below), so retrying it doesn't
    // reintroduce the per-call churn this module exists to remove.
    await withFsRetry(() => cp(srcRoot, localSrcRoot, { recursive: true }))
  }

  async function syncBackAndDispose(): Promise<void> {
    try {
      // A run that never actually created any local content — srcRoot
      // didn't exist beforehand (nothing to copy down, see above) AND
      // nothing ever wrote to localSrcRoot either — has nothing to sync
      // back at all. Left as a no-op rather than trying to cp() a path
      // that was never created: in runCodingForElement's real flow this
      // never happens (scaffoldProjectSourceTree always creates at least
      // marker files before any agent runs), but this function needs to
      // stay correct standalone too, not only under that one caller's
      // specific sequencing.
      const localSrcRootExists = await stat(localSrcRoot).then(
        () => true,
        () => false,
      )
      if (!localSrcRootExists) return

      // Same rename-based atomic swap already proven for
      // isolatedWorkspace.ts's per-element merge-back, applied here at the
      // whole-tree level instead: stage the finished local copy under a
      // disposal-safe sibling name on the SAME share as srcRoot (so the
      // final swap is a single metadata rename, not a content copy), then
      // rename it into place. The only real-network content copy in this
      // entire flow is the cp() into stagingDir below — one bulk transfer,
      // not per-directory churn.
      const stagingDir = `${srcRoot}.vic-staging-${Date.now()}`
      const backupDir = `${srcRoot}.vic-backup-${Date.now()}`
      await withFsRetry(() => cp(localSrcRoot, stagingDir, { recursive: true, filter: (src) => !src.includes(`${path.sep}.git`) }))
      const srcRootExists = await stat(srcRoot).then(
        () => true,
        () => false,
      )
      if (srcRootExists) {
        try {
          await withFsRetry(() => rename(srcRoot, backupDir))
        } catch (err) {
          await rm(stagingDir, { recursive: true, force: true }).catch(() => {})
          throw new Error(
            `Failed to sync Coding output back into ${srcRoot} — the original is untouched, and the new output was safely discarded. The run can be retried. Underlying error: ${(err as Error).message}`,
          )
        }
        try {
          await withFsRetry(() => rename(stagingDir, srcRoot))
        } catch (err) {
          await rename(backupDir, srcRoot).catch(() => {})
          throw new Error(
            `Failed to sync Coding output back into ${srcRoot} — the original was restored, and the run's new output is preserved at ${stagingDir} for manual recovery if the restore above also failed. Underlying error: ${(err as Error).message}`,
          )
        }
        await rm(backupDir, { recursive: true, force: true }).catch(() => {})
      } else {
        // srcRoot didn't exist before this run (first-ever Coding run for
        // this project) — nothing to rename out of the way, just move the
        // finished local copy straight into place.
        await withFsRetry(() => rename(stagingDir, srcRoot))
      }
    } finally {
      await rm(localProjectDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  return { localProjectDir, localSrcRoot, syncBackAndDispose }
}
