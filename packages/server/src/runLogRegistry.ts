// In-memory registry of in-flight/just-finished Coding-stage CLI runs,
// keyed by a client-generated runToken (see /run-coding's handling of
// req.body.runToken) — lets the polling GET /api/coding/runs/:token/log
// route show live output while the blocking POST /run-coding request is
// still awaiting the CLI subprocess (see AgentRunOptions.onChunk, which is
// what actually feeds appendLog below).
//
// Also owns the per-project run lock (acquireProjectRunLock /
// releaseProjectRunLock): every route that spawns a Coding-stage CLI writes
// into the same shared git working tree (store.projectDir(project.id)) —
// /run-coding and the QA test-file-generation route both do this — so at
// most one such CLI may run against a given project at a time, regardless
// of which user/tab/route started it. Locks are keyed by project id, so
// they're fully independent across projects: two different projects can
// run Coding at the same instant with no interaction, since they never
// share a directory or a lock key.
//
// Deliberately in-memory only, same "resets on restart, that's fine" trust
// model as sessionTokenUsage in index.ts — a log is meaningless after a
// restart anyway, since the CLI process it described would be gone too. A
// lock is the same: if the server restarts mid-run, the CLI subprocess and
// everything that was tracking it are gone together, so there is nothing
// stale left to hold the lock open.
// No persistence, no size cap, no LRU: this app's usage pattern (a small
// team, a handful of concurrent runs at most) doesn't need it.

interface RunLogEntry {
  chunks: string[]
  done: boolean
  createdAt: number
  // Updated on every appended chunk — lets a poller distinguish "actively
  // producing output" from "stalled" (see readRunLog's staleForMs) without
  // the server needing to guess at a fixed CLI-specific timeout itself.
  lastActivityAt: number
}

// How long a finished run's entry survives after finishRunLog — long
// enough for the client's last poll (on its own ~1.5s interval, see
// CodingScreen.tsx) to observe done:true and stop polling, short enough
// that a long server session running many Coding runs doesn't accumulate
// unbounded memory.
const FINISHED_ENTRY_TTL_MS = 2 * 60 * 1000

const registry = new Map<string, RunLogEntry>()

// Registers a new run and returns the append function to hand to
// AgentRunOptions.onChunk — the caller (an /run-coding-style route) is
// expected to call finishRunLog(token) in a `finally` once the CLI
// subprocess has actually exited, regardless of success/failure.
export function startRunLog(token: string): (chunk: string) => void {
  registry.set(token, { chunks: [], done: false, createdAt: Date.now(), lastActivityAt: Date.now() })
  return (chunk: string) => {
    const entry = registry.get(token)
    if (entry) {
      entry.chunks.push(chunk)
      entry.lastActivityAt = Date.now()
    }
  }
}

export function finishRunLog(token: string): void {
  const entry = registry.get(token)
  if (!entry) return
  entry.done = true
  setTimeout(() => registry.delete(token), FINISHED_ENTRY_TTL_MS)
}

export function readRunLog(
  token: string,
): { text: string; done: boolean; msSinceLastActivity: number } | undefined {
  const entry = registry.get(token)
  if (!entry) return undefined
  return { text: entry.chunks.join(''), done: entry.done, msSinceLastActivity: Date.now() - entry.lastActivityAt }
}

interface ProjectLock {
  runToken: string
  // storyId is kept for Planning's own still-live /backlog/stories/:storyId/
  // run-coding route (hide-not-delete — that route is untouched);
  // architectureElementId is the new element-scoped Coding path's
  // equivalent. A given lock only ever populates whichever one is relevant
  // to how it was acquired — never both.
  storyId?: string
  architectureElementId?: string
  userId?: string
  startedAt: number
  // Aborts the in-flight CLI run (see AgentRunOptions.signal on both agent
  // clients) — set by the route right after acquiring the lock. Backs the
  // Coding screen's Cancel button (cancelProjectRun below) so a stuck run
  // doesn't have to be waited out until CODING_RUN_TIMEOUT_MS elapses.
  cancel: () => void
}

const projectLocks = new Map<string, ProjectLock>()

export class ProjectRunLockedError extends Error {
  constructor(public readonly lock: ProjectLock) {
    super('A Coding run is already in progress for this project')
    this.name = 'ProjectRunLockedError'
  }
}

// Throws ProjectRunLockedError (rather than silently queueing or
// overwriting) if this project already has a run in flight — a shared git
// working tree can't safely take two concurrent agentic CLI writers, so the
// second request is rejected outright and the caller (a route handler) is
// expected to surface that as a clear error rather than let both runs race
// on disk. Call releaseProjectRunLock in a `finally` alongside
// finishRunLog, regardless of the run's outcome.
export function acquireProjectRunLock(
  projectId: string,
  runToken: string,
  info: { storyId?: string; architectureElementId?: string; userId?: string; cancel: () => void },
): void {
  const existing = projectLocks.get(projectId)
  if (existing) throw new ProjectRunLockedError(existing)
  projectLocks.set(projectId, { runToken, startedAt: Date.now(), ...info })
}

// Aborts whatever CLI run currently holds this project's lock, if any —
// backs the Coding screen's Cancel button. Does not itself remove the lock:
// the aborted run's own route handler still runs its `finally`
// (releaseProjectRunLock) once the agent client's promise actually rejects,
// same as the CODING_RUN_TIMEOUT_MS path. Returns false if nothing was
// locked, so the route can tell the caller there was nothing to cancel.
export function cancelProjectRun(projectId: string): boolean {
  const existing = projectLocks.get(projectId)
  if (!existing) return false
  existing.cancel()
  return true
}

export function releaseProjectRunLock(projectId: string, runToken: string): void {
  const existing = projectLocks.get(projectId)
  // Only the lock's own owner releases it — guards against a slow/late
  // `finally` from a run that had already lost a race (it never actually
  // acquired the lock, since acquireProjectRunLock would have thrown for
  // it) from clearing a different, legitimately-running lock.
  if (existing && existing.runToken === runToken) projectLocks.delete(projectId)
}

export function readProjectRunLock(projectId: string): ProjectLock | undefined {
  return projectLocks.get(projectId)
}
