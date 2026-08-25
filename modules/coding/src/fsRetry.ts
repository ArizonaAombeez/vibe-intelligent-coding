// Shared retry helper for filesystem ops against VIC's project storage,
// which is commonly a mapped SMB/Samba network drive (see PROJECTS_ROOT in
// packages/server/src/index.ts). Network shares exhibit transient
// EPERM/EBUSY/ENOTEMPTY/ENOENT errors that a plain local NTFS path never
// does — e.g. an antivirus/indexer briefly holding a handle open right
// after a large recursive copy, or the SMB client's own directory-listing
// cache not yet reflecting a delete or create that already completed
// server-side. ENOENT is the mirror-image symptom of ENOTEMPTY: instead of
// a just-deleted directory still looking non-empty, a just-created (or
// about-to-exist) parent can briefly look entirely absent to the client's
// cache — seen in practice as `mkdir` on a fresh element folder throwing
// ENOENT on its parent immediately after wipeScopedSubfolder's delete,
// even though scaffoldProjectSourceTree's own mkdir uses recursive:true.
// Originally scaffold.ts-only (proven against this project's real share);
// extracted so isolatedWorkspace.ts's merge-back step (rm/cp/rename against
// the same kind of path) can reuse the identical, already-verified retry
// behavior instead of duplicating or omitting it.
const RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1500, 2000, 3000]

const RETRYABLE_CODES = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY', 'ENOENT'])

export async function withFsRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (!code || !RETRYABLE_CODES.has(code) || attempt >= RETRY_DELAYS_MS.length) throw err
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]))
    }
  }
}
