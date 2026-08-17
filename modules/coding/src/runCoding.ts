import type { CodingRun, CodingRunStatus, InterfaceContract, Project } from 'vic-requirements-elicitation'
import type { CodingAgentClient } from './agentClient.js'
import { elementSubfolderName, scaffoldProjectSourceTree, sourceTreeRoot } from './scaffold.js'
import { gitCommitAll, gitDiffText, gitInitIfNeeded, gitResetHardToHead, gitStatusPorcelain } from './gitDiff.js'
import { enforceWriteScope } from './scopeGate.js'

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

// Any InterfaceContract where this element is either endpoint — context
// only (not a scope expansion): the element still only ever writes to its
// own subfolder, but seeing the contract's operations helps the agent
// implement its own side compatibly with the other endpoint.
function relevantInterfaceContracts(project: Project, architectureElementId: string): InterfaceContract[] {
  return (project.architecture?.interfaceContracts ?? []).filter(
    (c) => c.fromId === architectureElementId || c.toId === architectureElementId,
  )
}

// Self-review/refactor is baked into the outbound prompt unconditionally
// (Area D, resolved) — there is no separate manual review step in this
// pipeline, so the Dev persona is always instructed to review and refactor
// its own change before finishing.
const SELF_REVIEW_INSTRUCTION = `Before finishing, review your own changes for correctness, and refactor for
clarity. Favour reusing existing code already in this subfolder over
duplicating logic.`

export function buildCodingPrompt(project: Project, architectureElementId: string, allowedRelativePrefix: string): string {
  const parts: string[] = []
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

  const contracts = relevantInterfaceContracts(project, architectureElementId)
  for (const contract of contracts) {
    if (contract.operations.length === 0) continue
    const otherId = contract.fromId === architectureElementId ? contract.toId : contract.fromId
    parts.push(`Interface contract with ${formatElement(project, otherId)}:`)
    parts.push(
      contract.operations
        .map((op) => `- ${op.name}: ${op.description} (request: ${op.request}; response: ${op.response})`)
        .join('\n'),
    )
  }

  if (project.codingConventions) {
    parts.push(`Coding conventions to follow:\n${project.codingConventions}`)
  }

  parts.push(SELF_REVIEW_INSTRUCTION)
  return parts.join('\n\n')
}

export interface RunCodingOptions {
  model?: string
  effort?: string
  permissionMode?: string
  // Test injection seam, threaded through to the agent client.
  binary?: string
  binaryArgs?: string[]
  // Provider-routing fields, only meaningful to OpenCodeAgentClient (ignored
  // by ClaudeCodeAgentClient) — see CodingAgentClient/AgentRunOptions.
  apiKey?: string
  baseUrl?: string
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

  await scaffoldProjectSourceTree(project, projectDir)
  const srcRoot = sourceTreeRoot(projectDir)
  await gitInitIfNeeded(srcRoot)
  const beforeStatus = await gitStatusPorcelain(srcRoot)

  const prompt = buildCodingPrompt(project, architectureElementId, allowedRelativePrefix)

  let runResult
  try {
    runResult = await agentClient.runAgentTask(prompt, {
      cwd: srcRoot,
      permissionMode: options.permissionMode ?? 'acceptEdits',
      model: options.model,
      effort: options.effort,
      binary: options.binary,
      binaryArgs: options.binaryArgs,
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      onChunk: options.onChunk,
      signal: options.signal,
    })
  } catch (err) {
    const rawLog = (err as { rawLog?: string }).rawLog ?? (err as Error).message
    const exitCode = (err as { exitCode?: number | null }).exitCode ?? null
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
    }
  }

  const gateResult = await enforceWriteScope(srcRoot, allowedRelativePrefix, beforeStatus)
  if (!gateResult.ok) {
    const remainingDiff = await gitDiffText(srcRoot)
    return {
      id: `CODINGRUN-${startedAt}`,
      architectureElementId,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: 'rejected-scope',
      diff: remainingDiff,
      rawLog: runResult.rawLog,
      exitCode: runResult.exitCode,
      allowedSubfolder: allowedRelativePrefix,
      rejectedFiles: gateResult.rejectedFiles,
      usage: runResult.usage,
    }
  }

  // Captured before committing — HEAD still points at the pre-run commit
  // here, so this is the diff the accepted change actually introduces.
  const diff = await gitDiffText(srcRoot)

  // Guards against a silent no-op agent run (CLI exits 0 with no error, but
  // never actually wrote any file). Ordinarily a harmless empty diff, but
  // it's catastrophic specifically after a "recode from scratch" wipe
  // (wipeScopedSubfolder deletes the folder via a raw fs.rm, not a git
  // commit): with nothing to replace the wipe, committing here would
  // permanently destroy the previous implementation and leave the element's
  // folder empty. Detected as "every hunk is deletion-only" — a diff with
  // no '+' content line means nothing new was written, whether or not a
  // wipe preceded this run.
  const hasAddedContent = /^\+(?!\+\+)/m.test(diff)
  if (diff.length > 0 && !hasAddedContent) {
    await gitResetHardToHead(srcRoot)
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
  }
}
