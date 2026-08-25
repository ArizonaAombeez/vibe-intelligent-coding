import { connectedPairs } from 'vic-requirements-elicitation'
import type { Project } from 'vic-requirements-elicitation'

export type ScopeReadiness =
  | { ready: true }
  | { ready: false; reason: 'element-not-coded' | 'interface-element-not-coded' }

export interface ScopeReadinessEntry {
  scopeKey: string
  readiness: ScopeReadiness
}

function hasSuccessfulCodingRun(project: Project, elementId: string): boolean {
  return (project.codingRuns ?? []).some((run) => run.architectureElementId === elementId && run.status === 'success')
}

// Per-scope readiness for Test Execution (Area F) — a requirement-based test
// case is only meaningfully runnable once its element (or, for an interface
// pair, both connected elements) has at least one successful Step 5 Coding
// run; before that there is no code on disk for the test to exercise
// (resolveExecutionScope would reject it as 'scope-not-found' the moment a
// run is attempted). Computed from project.codingRuns directly rather than
// re-deriving from disk, since "has a successful CodingRun" is the readiness
// definition the UI surfaces to the user, not "folder happens to exist".
export function computeScopeReadiness(project: Project): Map<string, ScopeReadiness> {
  const result = new Map<string, ScopeReadiness>()
  const elementIds = (project.architecture?.elements ?? []).map((e) => e.id)

  for (const elementId of elementIds) {
    const scopeKey = `el:${elementId}`
    result.set(scopeKey, hasSuccessfulCodingRun(project, elementId) ? { ready: true } : { ready: false, reason: 'element-not-coded' })
  }

  const connected = project.architecture ? connectedPairs(project.architecture.elements) : []
  for (const pair of connected) {
    const scopeKey = `if:${[pair.fromId, pair.toId].sort().join('|')}`
    const bothCoded = hasSuccessfulCodingRun(project, pair.fromId) && hasSuccessfulCodingRun(project, pair.toId)
    result.set(scopeKey, bothCoded ? { ready: true } : { ready: false, reason: 'interface-element-not-coded' })
  }

  return result
}

export function scopeReadinessEntries(project: Project): ScopeReadinessEntry[] {
  return [...computeScopeReadiness(project)].map(([scopeKey, readiness]) => ({ scopeKey, readiness }))
}
