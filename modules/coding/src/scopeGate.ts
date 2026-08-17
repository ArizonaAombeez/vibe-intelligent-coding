import path from 'node:path'
import { sharedInterfaceSubfolderName } from './scaffold.js'
import { gitRevertPaths, gitStatusPorcelain } from './gitDiff.js'

export interface ResolvedScope {
  allowedRelativePrefix: string
}

export interface RejectedScope {
  rejected: 'multi-element'
}

// Structural shape shared by TestCase (Area E/F) — scoped to exactly one
// architecture element or one interface pair, with the identical field
// names/semantics Story used to have. Deviation from the original plan for
// this migration: the plan called for deleting resolveAllowedScope/
// ScopableEntity/RejectedScope entirely as "Coding's own now-obsolete
// internal plumbing," on the premise that modules/coding would have no
// other Story-shaped consumer once runCoding.ts stopped calling them. That
// premise doesn't hold — modules/testing's executionScopeGate.ts and
// writeTestFiles.ts both still depend on this function for TestCase's own
// (pre-existing, independent-of-Story) single-element/interface-pair
// scoping, which the plan explicitly says stays untouched. Removing this
// would have broken Test Creation/Execution's still-live interface-test
// file generation, so it's kept — vic-coding's own Coding path
// (runCoding.ts) simply no longer calls it, but the function remains a
// real, in-use export for vic-testing.
export interface ScopableEntity {
  architectureElementId: string | null
  interfaceElementIds?: [string, string]
}

// Code-change isolation by architecture element (Area B/D, resolved) — the
// 3+-element rejection must happen BEFORE the CLI is ever invoked. A
// 2-element interface TestCase is scoped to the shared-interface subfolder
// only, never either element's own subfolder.
export function resolveAllowedScope(
  entity: ScopableEntity,
  elementSubfolderById: Map<string, string>,
): ResolvedScope | RejectedScope {
  if (entity.interfaceElementIds) {
    if (entity.interfaceElementIds.length !== 2) return { rejected: 'multi-element' }
    const [fromId, toId] = entity.interfaceElementIds
    return { allowedRelativePrefix: path.join('_shared-interfaces', sharedInterfaceSubfolderName(fromId, toId)) }
  }
  if (entity.architectureElementId) {
    const dirName = elementSubfolderById.get(entity.architectureElementId)
    if (!dirName) return { rejected: 'multi-element' }
    return { allowedRelativePrefix: dirName }
  }
  return { rejected: 'multi-element' }
}

export interface EnforceWriteScopeResult {
  ok: boolean
  rejectedFiles: string[]
}

// The hard technical gate (Area D, resolved: "any attempted write outside
// scope fails the run rather than being silently allowed"). Called after
// the CLI run: diffs the current working-tree status against beforeStatus
// to find exactly what this run changed, reverts anything outside
// allowedRelativePrefix, and leaves in-scope changes untouched.
export async function enforceWriteScope(
  srcRoot: string,
  allowedRelativePrefix: string,
  beforeStatus: string[],
): Promise<EnforceWriteScopeResult> {
  const afterStatus = await gitStatusPorcelain(srcRoot)
  const beforeSet = new Set(beforeStatus)
  const changedThisRun = afterStatus.filter((p) => !beforeSet.has(p))

  const allowedPrefix = allowedRelativePrefix.endsWith(path.sep) ? allowedRelativePrefix : allowedRelativePrefix + path.sep
  const rejectedFiles = changedThisRun.filter((p) => {
    const normalized = p.split('/').join(path.sep)
    return !(normalized === allowedRelativePrefix || normalized.startsWith(allowedPrefix))
  })

  if (rejectedFiles.length > 0) {
    await gitRevertPaths(srcRoot, rejectedFiles)
    return { ok: false, rejectedFiles }
  }
  return { ok: true, rejectedFiles: [] }
}
