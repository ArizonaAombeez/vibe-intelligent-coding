import { checkInterfaces } from 'vic-requirements-elicitation'
import type { CodingRun, CodingRunStatus, ElementInterfaceDefinition, Project } from 'vic-requirements-elicitation'
import type { CodingAgentClient } from './agentClient.js'
import { elementSubfolderName, scaffoldProjectSourceTree, sourceTreeRoot, wipeScopedSubfolder } from './scaffold.js'
import { gitCommitAll, gitInitIfNeeded } from './gitDiff.js'
import { withIsolatedElementWorkspace } from './isolatedWorkspace.js'
import { openLocalSourceTree } from './localSourceTree.js'

// Modularity rule (resolved): a Coding run may only touch a module (the
// code implementing one architecture element) that's actually impacted by
// a failing test or a requirement change — both of which surface as one of
// this element's allocated requirements sitting at 'allocated'
// (Architecture's resting status, restored either by requirementStatusFlip's
// applyPassThreshold on a failing test, or by updateRequirementText's
// regression on an edit — see elicitation.ts). An element with no
// 'allocated' requirement allocated to it has nothing pending and should
// not re-run Coding.
export function isElementEligibleForCoding(project: Project, architectureElementId: string): boolean {
  return project.requirements.some(
    (r) => !r.deletedAt && r.architectureElements.includes(architectureElementId) && r.status === 'allocated',
  )
}

// "An element cannot be coded until its I/O interface is defined" (Area B),
// plus the newer hard-block rule (Area B/D, resolved): the instant a master
// InterfaceDefinition changes, every participant is flagged aligned:false
// (architecture.ts's markParticipantsMisaligned) and stays blocked here
// until a human reconciles that element's own copy against the new master
// AND against this element's own requirements (reconcileElementInterface).
// Unlike checkInterfaces itself (advisory, never blocks a phase transition),
// this is a hard gate specifically on Coding — undefined, incomplete, or
// misaligned interfaces all refuse the run, regardless of requirement-
// allocation status. Returns a human-readable reason (for the rejected
// run's rawLog) when blocked, or undefined when the element's own
// interfaces are fully specified and aligned. Only this element's own
// connections are considered — an unrelated element's problem elsewhere in
// the architecture never blocks this one.
export function interfaceGateReasonForElement(project: Project, architectureElementId: string): string | undefined {
  const element = project.architecture?.elements.find((e) => e.id === architectureElementId)
  if (!element) return undefined
  const { undefinedPairs, incompleteOperations, misalignedElements, danglingElementInterfaces } = checkInterfaces(project)
  const ownUndefined = undefinedPairs.filter((p) => p.fromId === architectureElementId || p.toId === architectureElementId)
  const ownIncomplete = incompleteOperations.filter(
    (o) => o.fromId === architectureElementId || o.toId === architectureElementId,
  )
  const ownMisaligned = misalignedElements.filter((m) => m.elementId === architectureElementId)
  const ownDangling = danglingElementInterfaces.filter((d) => d.elementId === architectureElementId)
  if (ownUndefined.length === 0 && ownIncomplete.length === 0 && ownMisaligned.length === 0 && ownDangling.length === 0) {
    return undefined
  }

  const parts: string[] = []
  if (ownUndefined.length > 0) {
    parts.push(
      `undefined interface(s) with ${ownUndefined.map((p) => (p.fromId === architectureElementId ? p.toId : p.fromId)).join(', ')}`,
    )
  }
  if (ownIncomplete.length > 0) {
    parts.push(
      `operation(s) missing I/O detail (${ownIncomplete.map((o) => `${o.operationName}: ${o.missingFields.join(', ')}`).join('; ')})`,
    )
  }
  if (ownMisaligned.length > 0) {
    const names = ownMisaligned
      .map((m) => (project.architecture?.interfaceDefinitions ?? []).find((d) => d.id === m.masterDefinitionId)?.name ?? m.masterDefinitionId)
      .join(', ')
    parts.push(
      `out-of-date copy of ${names} — a master interface changed since this element's own understanding of it was last reconciled`,
    )
  }
  if (ownDangling.length > 0) {
    // A corrupted/broken reference, not merely out of date — the id this
    // element's own copy points at doesn't exist anywhere in the project's
    // interfaceDefinitions, so there is no master content to reconcile
    // against. Distinct wording (and a concrete fix) rather than folding
    // this into the "out-of-date" message above, which would wrongly imply
    // reconciling against a real master would resolve it.
    parts.push(
      `broken reference to a deleted or corrupted interface (${ownDangling.map((d) => d.masterDefinitionId).join(', ')}) — this connection has no master interface content behind it. Re-define this connection from the Architecture screen (Check Interfaces, then Define) to replace it with a real interface, or remove the connection if it's no longer needed`,
    )
  }
  return `This element's I/O interfaces are not fully defined yet — ${parts.join('; ')}. Define and complete every interface (range, resolution, unit, and minimum update frequency or driven-directly), and review any out-of-date interface against this element's own requirements before Coding can proceed.`
}

function formatElement(project: Project, elementId: string): string {
  const element = project.architecture?.elements.find((e) => e.id === elementId)
  if (!element) return elementId
  return `${element.id} (${element.kind}): ${element.name} — ${element.responsibility}`
}

// Every requirement currently allocated to this element — queried live from
// requirement.architectureElements, never a cached/derived list. A
// requirement allocated to multiple elements appears in each element's own
// list independently.
export function requirementsAllocatedToElement(project: Project, architectureElementId: string) {
  return project.requirements.filter(
    (r) => !r.deletedAt && r.architectureElements.includes(architectureElementId),
  )
}

function formatRequirements(requirements: Project['requirements']): string {
  return requirements.map((r) => `${r.id}: ${r.text}`).join('\n')
}

// This element's own local copy of every interface it participates in —
// context only (not a scope expansion): the element still only ever writes
// to its own subfolder, but seeing each copy's operations and role
// (produces/consumes/both) helps the agent implement its own side
// compatibly with the other participants. Reads element.elementInterfaces
// directly (Tier 2) rather than the project-wide interfaceDefinitions list
// (Tier 1) — the whole point of the two-tier model is that the coding
// prompt only ever needs what's already denormalized onto this element.
function relevantInterfaceDefinitions(project: Project, architectureElementId: string): ElementInterfaceDefinition[] {
  const element = project.architecture?.elements.find((e) => e.id === architectureElementId)
  return element?.elementInterfaces ?? []
}

function otherParticipantNames(project: Project, architectureElementId: string, masterDefinitionId: string): string {
  const definition = (project.architecture?.interfaceDefinitions ?? []).find((d) => d.id === masterDefinitionId)
  if (!definition) return masterDefinitionId
  return definition.participants
    .filter((p) => p.elementId !== architectureElementId)
    .map((p) => formatElement(project, p.elementId))
    .join(', ')
}

// Self-review/refactor is baked into the outbound prompt unconditionally
// (Area D, resolved) — there is no separate manual review step in this
// pipeline, so the Dev persona is always instructed to review and refactor
// its own change before finishing.
const SELF_REVIEW_INSTRUCTION = `Before finishing, review your own changes for correctness, and refactor for
clarity. Favour reusing existing code already in this subfolder over
duplicating logic.`

// Most recent run with status 'success' for this element, or undefined if
// it has never successfully completed one — the single lookup both
// interfaceChangedSinceLastCoding and classifyCodingTaskReason need to know
// whether this is the element's first build.
function lastSuccessfulCodingRun(project: Project, architectureElementId: string) {
  return (project.codingRuns ?? [])
    .filter((r) => r.architectureElementId === architectureElementId && r.status === 'success')
    .sort((a, b) => a.finishedAt.localeCompare(b.finishedAt))
    .at(-1)
}

// What kind of Coding task this run actually is, driving buildCodingPrompt's
// task-specific framing sentence (Area D follow-up: "tell the LLM what it's
// doing" instead of sending the identical prompt for every trigger).
// Priority order matters: fromScratch is a hard UI choice that overrides
// everything else; interfaceChangedSinceLastCoding is a live, always-
// current signal so it's checked before the one-shot stored
// pendingRecodeReason flag; initial-build only applies with no prior
// success at all; manual-recode is the fallback when nothing more specific
// is known (plain "Update Code" click with no fresh driver).
export type CodingTaskReason =
  | 'rebuild-from-scratch'
  | 'interface-update'
  | 'initial-build'
  | 'requirement-update'
  | 'user-reported-issue'
  | 'manual-recode'

export function classifyCodingTaskReason(
  project: Project,
  architectureElementId: string,
  fromScratch: boolean,
): CodingTaskReason {
  if (fromScratch) return 'rebuild-from-scratch'
  if (interfaceChangedSinceLastCoding(project, architectureElementId)) return 'interface-update'
  if (!lastSuccessfulCodingRun(project, architectureElementId)) return 'initial-build'
  const element = project.architecture?.elements.find((e) => e.id === architectureElementId)
  if (element?.pendingRecodeReason === 'requirement-update') return 'requirement-update'
  if (element?.pendingRecodeReason === 'user-reported-issue') return 'user-reported-issue'
  return 'manual-recode'
}

const TASK_REASON_FRAMING: Record<CodingTaskReason, string> = {
  'initial-build':
    'You are implementing this architecture element for the first time — there is no existing code yet.',
  'requirement-update':
    "You are updating this element's existing code because one of its requirements changed. Review the current implementation, then make the necessary changes — preserve working behavior for anything not affected by the requirement change below.",
  'interface-update':
    "You are updating this element's existing code because one of its interface contracts changed. Update this element's side of the contract to match; do not change unrelated behavior.",
  'rebuild-from-scratch':
    "You are rebuilding this element's code from scratch — its folder has just been cleared. Ignore any assumptions about prior code; write a complete fresh implementation.",
  'user-reported-issue':
    "You are fixing this element's existing code because a user testing it reported a problem (see their description below). Review the current implementation, reproduce the issue in your head against their description, then make the necessary changes — preserve working behavior for anything not affected by the reported issue.",
  'manual-recode':
    'You are revising this element\'s existing code (a manual re-code request). Review the current implementation and the requirements/interfaces below, then make the necessary changes.',
}

export function buildCodingPrompt(
  project: Project,
  architectureElementId: string,
  allowedRelativePrefix: string,
  reason: CodingTaskReason,
): string {
  const parts: string[] = []

  if (project.description) {
    parts.push(`Project overview:\n${project.description}`)
  }
  if (project.runInstructions) {
    parts.push(`How this project is built/run:\n${project.runInstructions}`)
  }

  parts.push(TASK_REASON_FRAMING[reason])
  if (reason === 'user-reported-issue') {
    const element = project.architecture?.elements.find((e) => e.id === architectureElementId)
    if (element?.pendingRecodeDetail) {
      parts.push(`User's reported issue:\n${element.pendingRecodeDetail}`)
    }
  }
  parts.push(
    `You may ONLY create or modify files under ${allowedRelativePrefix}/ relative to your working directory — do not touch any file outside that path.`,
  )

  parts.push('This is the architecture element you are implementing:')
  parts.push(formatElement(project, architectureElementId))

  const requirements = requirementsAllocatedToElement(project, architectureElementId)
  if (requirements.length > 0) {
    parts.push('Requirements currently allocated to this element:')
    parts.push(formatRequirements(requirements))
  }

  const interfaces = relevantInterfaceDefinitions(project, architectureElementId)
  for (const entry of interfaces) {
    if (entry.operations.length === 0) continue
    const others = otherParticipantNames(project, architectureElementId, entry.masterDefinitionId)
    const roleText = entry.role === 'both' ? 'both produces and consumes it' : `${entry.role} it`
    parts.push(`Interface contract with ${others} (this element ${roleText}):`)
    parts.push(
      entry.operations
        .map((op) => {
          const ioDetail = [
            op.range && `range: ${op.range}`,
            op.resolution && `resolution: ${op.resolution}`,
            op.unit && `unit: ${op.unit}`,
            op.drivenDirectly ? 'driven directly (not periodic)' : op.updateFrequency && `min update frequency: ${op.updateFrequency}`,
          ]
            .filter(Boolean)
            .join(', ')
          return `- ${op.name}: ${op.description} (request: ${op.request}; response: ${op.response}${ioDetail ? `; ${ioDetail}` : ''})`
        })
        .join('\n'),
    )
  }

  if (project.codingConventions) {
    parts.push(`Coding conventions to follow:\n${project.codingConventions}`)
  }

  parts.push(SELF_REVIEW_INSTRUCTION)
  return parts.join('\n\n')
}

// The Coding-tab "needs re-coding" trigger (Area B/D, resolved) — distinct
// from, and sequenced after, interfaceGateReasonForElement's hard block:
// while any of this element's own interface copies is aligned:false, the
// element is blocked (surfaced by the gate above), not "needs re-coding".
// Only once every copy is back to aligned:true (a human has reconciled it)
// AND the master moved since this element's code was last generated does
// this report true — the review is done, the block is lifted, but the
// element's actual source still reflects the pre-change interface.
export function interfaceChangedSinceLastCoding(project: Project, architectureElementId: string): boolean {
  const element = project.architecture?.elements.find((e) => e.id === architectureElementId)
  if (!element) return false
  if (element.elementInterfaces.some((ei) => !ei.aligned)) return false

  const lastSuccess = (project.codingRuns ?? [])
    .filter((r) => r.architectureElementId === architectureElementId && r.status === 'success')
    .sort((a, b) => a.finishedAt.localeCompare(b.finishedAt))
    .at(-1)
  if (!lastSuccess) return false

  const definitionsById = new Map((project.architecture?.interfaceDefinitions ?? []).map((d) => [d.id, d]))
  return element.elementInterfaces.some((ei) => {
    const definition = definitionsById.get(ei.masterDefinitionId)
    return definition ? definition.updatedAt > lastSuccess.finishedAt : false
  })
}

export interface RunCodingOptions {
  model?: string
  effort?: string
  permissionMode?: string
  // Whether the caller already wiped this element's folder before this call
  // (server route's wipeScopedSubfolder, "Code All") — purely a prompt-
  // classification signal here (classifyCodingTaskReason), the wipe itself
  // already happened by the time runCodingForElement runs.
  fromScratch?: boolean
  // Test injection seam, threaded through to the agent client.
  binary?: string
  binaryArgs?: string[]
  // Provider-routing fields, only meaningful to OpenCodeAgentClient (ignored
  // by ClaudeCodeAgentClient) — see CodingAgentClient/AgentRunOptions.
  apiKey?: string
  baseUrl?: string
  thinking?: string
  reasoningEffort?: string
  // Forwarded straight through to the agent client's own onChunk — lets a
  // caller (the server route) observe live CLI output while this run is
  // still in progress. See AgentRunOptions.onChunk for the full rationale.
  onChunk?: (chunk: string) => void
  // Forwarded straight through to the agent client's own signal — lets a
  // caller (the server route) time out or cancel the underlying CLI
  // subprocess. See AgentRunOptions.signal for the full rationale.
  signal?: AbortSignal
}

// Top-level orchestration for one "Run Coding" invocation against a single
// architecture element: check eligibility up front (no CLI cost for an
// element with nothing pending), scaffold, snapshot, invoke the agent, and
// either commit an in-scope change or revert an out-of-scope one. Every
// path returns a fully-populated CodingRun — the caller (server route) is
// responsible for persisting it and advancing requirement status. No
// scope-resolution/rejection step exists anymore — every run targets
// exactly one element's own folder (elementSubfolderName), so there is
// nothing to reject before invoking the CLI.
export async function runCodingForElement(
  project: Project,
  projectDir: string,
  architectureElementId: string,
  agentClient: CodingAgentClient,
  options: RunCodingOptions = {},
): Promise<CodingRun> {
  const startedAt = new Date().toISOString()

  if (!isElementEligibleForCoding(project, architectureElementId)) {
    return {
      id: `CODINGRUN-${startedAt}`,
      architectureElementId,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: 'rejected-not-eligible',
      diff: '',
      rawLog: "None of this element's allocated requirements are at 'allocated' status — nothing impacted by a failing test or a requirement change, so this module has no pending work for Coding to do.",
      exitCode: null,
      allowedSubfolder: '',
    }
  }

  const interfaceGateReason = interfaceGateReasonForElement(project, architectureElementId)
  if (interfaceGateReason) {
    return {
      id: `CODINGRUN-${startedAt}`,
      architectureElementId,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: 'rejected-not-eligible',
      diff: '',
      rawLog: interfaceGateReason,
      exitCode: null,
      allowedSubfolder: '',
    }
  }

  const element = project.architecture?.elements.find((e) => e.id === architectureElementId)
  if (!element) {
    return {
      id: `CODINGRUN-${startedAt}`,
      architectureElementId,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: 'rejected-not-eligible',
      diff: '',
      rawLog: `Architecture element ${architectureElementId} not found.`,
      exitCode: null,
      allowedSubfolder: '',
    }
  }

  const allowedRelativePrefix = elementSubfolderName(element)

  // Every filesystem operation this run performs (scaffold, git init/commit,
  // the per-element isolate/merge cycle) happens against a LOCAL working
  // copy of the project's src/ tree, not directly against projectDir (which
  // is commonly a mapped network/SMB drive — see localSourceTree.ts for why:
  // in-place churn there has independently produced five different
  // reproducible SMB errors across mkdir/rm/rename). The real projectDir is
  // only touched twice — once to copy this tree down, once to sync the
  // finished result back up — both via openLocalSourceTree/
  // syncBackAndDispose. syncBackAndDispose must run on every exit path once
  // the local session is open, success or failure, so the local temp copy
  // never leaks and (on failure) the real srcRoot is left exactly as it was
  // — hence the try/finally wrapping the entire remainder of this function.
  const localSession = await openLocalSourceTree(sourceTreeRoot(projectDir))
  try {
    // "Recode from scratch" (fromScratch:true) wipes this element's own
    // folder before scaffolding/coding — now performed on the local working
    // copy, same as everything else in this function, rather than as a
    // separate network-facing call the server route used to make before
    // ever invoking runCodingForElement. Order matters: wipe before
    // scaffold, so scaffoldProjectSourceTree's marker-file write lands in a
    // freshly (re)created folder either way, identical to the previous
    // two-step server-route sequence.
    if (options.fromScratch) {
      await wipeScopedSubfolder(localSession.localProjectDir, allowedRelativePrefix)
    }
    await scaffoldProjectSourceTree(project, localSession.localProjectDir)
    const srcRoot = localSession.localSrcRoot
    await gitInitIfNeeded(srcRoot)

    const reason = classifyCodingTaskReason(project, architectureElementId, options.fromScratch ?? false)
    const prompt = buildCodingPrompt(project, architectureElementId, allowedRelativePrefix, reason)
    // Consumed by this run's prompt regardless of outcome — a retry after a
    // rejected/errored run falls back to classifyCodingTaskReason's other
    // live signals (or 'manual-recode') rather than repeating a stale
    // reason.
    element.pendingRecodeReason = undefined
    element.pendingRecodeDetail = undefined

    let runResult
    let diff: string
    let changedPaths: string[]
    try {
      // Physical write-scope isolation (Area D follow-up): the CLI runs with
      // cwd inside a throwaway copy of ONLY this element's own folder — no
      // other element's files exist anywhere in its filesystem view, so
      // there's nothing to write outside of, not merely an instruction not
      // to. See isolatedWorkspace.ts. Replaces the old
      // run-against-shared-srcRoot-then-enforceWriteScope-after flow;
      // rejected-scope is no longer a reachable outcome for an element-only
      // run (a physical impossibility rather than a policy check), but the
      // status remains in CodingRunStatus for the interface-pair scoping
      // vic-testing still uses via scopeGate.ts.
      const runOnce = () =>
        withIsolatedElementWorkspace(srcRoot, allowedRelativePrefix, (isolatedCwd) =>
          agentClient.runAgentTask(prompt, {
            cwd: isolatedCwd,
            permissionMode: options.permissionMode ?? 'acceptEdits',
            model: options.model,
            effort: options.effort,
            binary: options.binary,
            binaryArgs: options.binaryArgs,
            apiKey: options.apiKey,
            baseUrl: options.baseUrl,
            thinking: options.thinking,
            reasoningEffort: options.reasoningEffort,
            onChunk: options.onChunk,
            signal: options.signal,
          }),
        )

      let isolated = await runOnce()

      // One retry, GLM only, when the CLI exited clean but wrote nothing.
      // OpenCode's providerId is only known after a run completes (it comes
      // back on AgentRunResult, not knowable from options up front), so this
      // gates on isolated.result.providerId rather than on options — see
      // OpenCodeAgentClient.runAgentTask's providerId: 'opencode' return.
      // This exists specifically for GLM-5.x's documented streamed-tool-call
      // bug (opencode/z.ai can drop tool-call deltas mid-stream, producing a
      // clean exit with no tool calls ever having landed) — a transient,
      // provider-side failure worth one retry, unlike Claude Code's
      // empty-output runs, which have not shown this pattern and don't get
      // the extra CLI cost.
      if (isolated.changedPaths.length === 0 && isolated.result.providerId === 'opencode') {
        isolated = await runOnce()
      }

      runResult = isolated.result
      diff = isolated.diff
      changedPaths = isolated.changedPaths
    } catch (err) {
      const rawLog = (err as { rawLog?: string }).rawLog ?? (err as Error).message
      const exitCode = (err as { exitCode?: number | null }).exitCode ?? null
      // Both agent clients' own error classes carry timing whenever the
      // failure happened after the subprocess spawned (see
      // ClaudeCodeAgentError/OpenCodeAgentError) — this is exactly the
      // failure mode a long-stall-then-timeout produces, so it's important
      // this survives onto a cli-error CodingRun, not just a success one.
      // No providerId on the thrown error itself (only AgentRunResult
      // carries that, and a thrown error never returns one) — model is
      // still known from options, so at least that half stays comparable.
      const timing = (err as { timing?: CodingRun['timing'] }).timing
      return {
        id: `CODINGRUN-${startedAt}`,
        architectureElementId,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: 'cli-error' satisfies CodingRunStatus,
        diff: '',
        rawLog,
        exitCode,
        allowedSubfolder: allowedRelativePrefix,
        model: options.model,
        timing,
      }
    }

    // Guards against a silent no-op agent run (CLI exits 0 with no error,
    // but never actually wrote any file). Ordinarily a harmless empty diff,
    // but it's catastrophic specifically after a "Code All" wipe
    // (wipeScopedSubfolder deletes the folder via a raw fs.rm before the
    // isolated copy is even taken): with nothing to replace the wipe, the
    // element's folder would be left empty. Two distinct no-op shapes both
    // need catching here: changedPaths.length === 0 (the agent touched
    // nothing inside its own isolated folder at all — diff is '', the most
    // common real-world case, e.g. the ai-opponent/game-engine elements that
    // ended up holding nothing but their marker file) and a non-empty diff
    // that's still deletion-only (every hunk removes content, none adds any
    // — a narrower case, kept for defense in depth). Either way
    // withIsolatedElementWorkspace never merged anything back into srcRoot
    // (it only merges when changedPaths is non-empty), so srcRoot itself
    // needs no reset here — unlike the old shared-tree flow, there is
    // nothing to undo.
    const hasAddedContent = /^\+(?!\+\+)/m.test(diff)
    if (changedPaths.length === 0 || (diff.length > 0 && !hasAddedContent)) {
      return {
        id: `CODINGRUN-${startedAt}`,
        architectureElementId,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: 'rejected-empty-output' satisfies CodingRunStatus,
        diff: '',
        rawLog: runResult.rawLog,
        exitCode: runResult.exitCode,
        allowedSubfolder: allowedRelativePrefix,
        usage: runResult.usage,
        providerId: runResult.providerId,
        model: options.model,
        timing: runResult.timing,
      }
    }

    await gitCommitAll(srcRoot, `Coding: ${element.id} ${element.name}`)

    return {
      id: `CODINGRUN-${startedAt}`,
      architectureElementId,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: 'success',
      diff,
      rawLog: runResult.rawLog,
      exitCode: runResult.exitCode,
      allowedSubfolder: allowedRelativePrefix,
      usage: runResult.usage,
      providerId: runResult.providerId,
      model: options.model,
      timing: runResult.timing,
    }
  } finally {
    // Runs for every outcome above (success, cli-error, rejected-empty-
    // output) — the local working copy always needs syncing back (it may
    // hold real scaffold/commit changes even on a rejected-empty-output
    // path, e.g. the marker file scaffoldProjectSourceTree just wrote) and
    // always needs disposing of regardless.
    await localSession.syncBackAndDispose()
  }
}
