import { cp, mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gitCommitAll, gitDiffText, gitInitIfNeeded, gitStatusPorcelain } from './gitDiff.js'
import { withFsRetry } from './fsRetry.js'

// Physical write-scope isolation (Area D follow-up: an instruction ("only
// touch files under X/") is not a guard — an agent can still read or write
// anywhere the CLI process's cwd gives it access to before any after-the-
// fact check runs. This replaces scopeGate.ts's detect-and-revert-after
// enforceWriteScope for the Coding path with a physical one: the CLI never
// runs anywhere near the other elements' files in the first place, on any
// platform, using nothing but plain Node fs — no OS ACLs, no containers.
//
// Runs entirely on local disk (os.tmpdir()), not the project's own
// (frequently network-shared) directory — deliberately sidesteps the same
// "dubious ownership"/SID-resolution git quirk gitDiff.ts's
// markSafeDirectory works around for the real srcRoot, and keeps the
// isolated copy fast regardless of where the project itself lives.

export interface IsolatedWorkspaceResult<T> {
  result: T
  // Diff of everything the callback wrote, captured from the isolated
  // repo's own git history — by construction (nothing but the allowed
  // element folder was ever copied in) this is already fully in-scope, so
  // there is nothing left to reject or revert here.
  diff: string
  changedPaths: string[]
}

// Copies allowedRelativePrefix out of srcRoot into a throwaway temp
// directory, runs fn with that directory as its only visible filesystem
// root, then copies whatever fn left behind back over the real
// srcRoot/allowedRelativePrefix and commits it there — mirroring the
// existing "one git repo per Coding run" shape (gitInitIfNeeded +
// gitStatusPorcelain + gitCommitAll) but scoped to the isolated copy
// instead of the shared tree. On any failure (fn throws, or the caller
// decides not to keep the result — see keep()), the temp directory is
// discarded and the real srcRoot is never touched, so no reset-hard/
// revert step is needed on that path either.
export async function withIsolatedElementWorkspace<T>(
  srcRoot: string,
  allowedRelativePrefix: string,
  fn: (isolatedCwd: string) => Promise<T>,
): Promise<IsolatedWorkspaceResult<T>> {
  const sourceDir = path.join(srcRoot, allowedRelativePrefix)
  const isolatedRoot = await mkdtemp(path.join(tmpdir(), 'vic-coding-'))
  try {
    await cp(sourceDir, isolatedRoot, { recursive: true })
    await gitInitIfNeeded(isolatedRoot)
    const beforeStatus = await gitStatusPorcelain(isolatedRoot)

    const result = await fn(isolatedRoot)

    const afterStatus = await gitStatusPorcelain(isolatedRoot)
    const beforeSet = new Set(beforeStatus)
    const changedPaths = afterStatus.filter((p) => !beforeSet.has(p))
    const diff = await gitDiffText(isolatedRoot)

    if (changedPaths.length === 0) {
      return { result, diff: '', changedPaths: [] }
    }

    // Merge back: the isolated copy is authoritative for this element's own
    // folder once fn succeeds — replace the real folder wholesale rather
    // than patching, same "whole subfolder" granularity scopeGate.ts always
    // used.
    //
    // Build the replacement at a staging path on the SAME share/volume as
    // sourceDir, then swap it in with a single rename — NOT a delete-then-
    // copy. rename() within one filesystem/share is a metadata-only
    // operation (no data movement), so it's effectively atomic even over
    // SMB, unlike a separate rm+cp pair which has a real window where
    // sourceDir is either half-deleted or briefly absent — the exact race
    // that produced the ENOTEMPTY this replaced. The old contents are moved
    // aside (also a same-share rename, same atomicity) rather than deleted
    // outright, so if anything below still fails, nothing is ever lost: at
    // worst the caller sees an error pointing at the staged/backup paths for
    // manual recovery.
    //
    // rename() can still throw ENOTEMPTY/EPERM/EBUSY on a network share
    // (e.g. the destination briefly still appears non-empty per the SMB
    // client's own cache, or an AV/indexer holds a transient handle) —
    // withFsRetry covers that residual flakiness, the same belt
    // scaffold.ts already needed for this project's share (see fsRetry.ts).
    const stagingDir = `${sourceDir}.vic-staging-${Date.now()}`
    const backupDir = `${sourceDir}.vic-backup-${Date.now()}`
    await withFsRetry(() =>
      cp(isolatedRoot, stagingDir, { recursive: true, filter: (src) => !src.includes(`${path.sep}.git`) }),
    )
    try {
      await withFsRetry(() => rename(sourceDir, backupDir))
    } catch (err) {
      // sourceDir itself is untouched (this rename never took effect) — the
      // only cleanup needed is the staged copy, which was never consumed.
      await rm(stagingDir, { recursive: true, force: true }).catch(() => {})
      throw new Error(
        `Failed to merge Coding output back into ${sourceDir} — the original folder is untouched, and the run's new output was safely discarded. The run can be retried. Underlying error: ${(err as Error).message}`,
      )
    }
    try {
      await withFsRetry(() => rename(stagingDir, sourceDir))
    } catch (err) {
      // The old content was already moved aside (backupDir) before this
      // step failed — restore it so sourceDir is never left missing.
      await rename(backupDir, sourceDir).catch(() => {})
      throw new Error(
        `Failed to merge Coding output back into ${sourceDir} — the original folder was restored, and the run's new output is preserved at ${stagingDir} for manual recovery if the restore above also failed. Underlying error: ${(err as Error).message}`,
      )
    }
    await rm(backupDir, { recursive: true, force: true }).catch(() => {})

    return { result, diff, changedPaths }
  } finally {
    // Best-effort cleanup of the throwaway local temp copy — deliberately
    // swallowed, not retried or rethrown. This is disposable scratch space
    // (os.tmpdir(), never the real project), so a transient EBUSY/ENOTEMPTY
    // here (an AV/indexer briefly holding a handle, the same class of
    // flakiness withFsRetry works around elsewhere) has zero bearing on
    // whether the run itself succeeded. Before this guard, a `finally` that
    // throws silently replaces whatever the `try` block was about to
    // return — including a fully successful run — which surfaced as a
    // genuinely completed Coding run being reported as 'cli-error' purely
    // because leftover temp-folder cleanup hit a transient error on the way
    // out. A stray vic-coding-* folder left behind under os.tmpdir() is a
    // trivial, self-cleaning-on-reboot cost next to silently discarding a
    // real result.
    await rm(isolatedRoot, { recursive: true, force: true }).catch(() => {})
  }
}
