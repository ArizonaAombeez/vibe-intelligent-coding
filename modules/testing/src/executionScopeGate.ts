import path from 'node:path'
import { existsSync } from 'node:fs'
import { resolveAllowedScope, type ScopableEntity } from 'vic-coding'

export interface ResolvedExecutionScope {
  cwd: string // absolute path: <srcRoot>/<allowedRelativePrefix>
  allowedRelativePrefix: string
}

export type RejectedExecutionScope = { rejected: 'multi-element' | 'scope-not-found' }

// The module/element-scoped execution gate (Area F, resolved). A test run
// is not expected to write files the way Coding is, so unlike scopeGate.ts
// this has no write-violation-and-revert step — its job is narrower: be
// the ONLY code path capable of producing a cwd a test subprocess is
// allowed to run in. Every call site that invokes runTestCommand
// (runElementTestSuite) MUST go through this function first and use its
// returned cwd verbatim — never a caller-supplied path. This is the
// literal mechanical enforcement of "scope test execution to only the
// relevant module/element": there is no direct
// runTestCommand({ cwd: arbitraryPath }) call site anywhere else in this
// module.
export function resolveExecutionScope(
  entity: ScopableEntity,
  elementSubfolderById: Map<string, string>,
  srcRoot: string,
): ResolvedExecutionScope | RejectedExecutionScope {
  const scope = resolveAllowedScope(entity, elementSubfolderById)
  if ('rejected' in scope) {
    return { rejected: 'multi-element' }
  }

  const cwd = path.join(srcRoot, scope.allowedRelativePrefix)

  // Defence against a future subfolder-naming bug ever producing a `../`
  // escape — re-derives the resolved cwd and checks it is still
  // genuinely inside srcRoot before returning it as something a caller is
  // allowed to pass to a subprocess.
  const resolvedCwd = path.resolve(cwd)
  const resolvedRoot = path.resolve(srcRoot)
  if (resolvedCwd !== resolvedRoot && !resolvedCwd.startsWith(resolvedRoot + path.sep)) {
    return { rejected: 'multi-element' }
  }

  // A test can't run against an element that was never scaffolded/coded
  // yet — the subfolder must actually exist on disk.
  if (!existsSync(resolvedCwd)) {
    return { rejected: 'scope-not-found' }
  }

  return { cwd: resolvedCwd, allowedRelativePrefix: scope.allowedRelativePrefix }
}
