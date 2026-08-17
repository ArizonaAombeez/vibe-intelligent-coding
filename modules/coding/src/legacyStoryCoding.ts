// Story-based Coding — kept working, unmodified in behaviour, for the
// still-live /backlog/stories/:storyId/run-coding server route (hide-not-
// delete: Planning/Story/Backlog stay fully functional, just unreachable
// from the UI nav). This file exists ONLY because that one still-callable
// route needs it; the new element-based Coding path (runCoding.ts) never
// imports from here, and the new CodingScreen.tsx never calls the
// story-scoped server route this backs. Kept in its own file (not
// re-merged into runCoding.ts) so runCoding.ts itself stays purely
// element-based/Story-free, matching the plan's intent for the module that
// actually got rewritten this migration — this is the one corner of
// vic-coding that still needs to know what a Story is, isolated on
// purpose.
import type { CodingRun, CodingRunStatus, Project, Story } from 'vic-requirements-elicitation'
import type { CodingAgentClient } from './agentClient.js'
import { elementSubfolderName, scaffoldProjectSourceTree, sourceTreeRoot } from './scaffold.js'
import { gitCommitAll, gitDiffText, gitInitIfNeeded, gitStatusPorcelain } from './gitDiff.js'
import { enforceWriteScope, resolveAllowedScope } from './scopeGate.js'
import type { RunCodingOptions } from './runCoding.js'

export function isStoryEligibleForCoding(project: Project, story: Story): boolean {
  return story.requirementIds.some((id) => {
    const requirement = project.requirements.find((r) => r.id === id && !r.deletedAt)
    return requirement?.status === 'allocated'
  })
}

export function findStoriesSharingScope(project: Project, story: Story): Story[] {
  const scope = resolveAllowedScope(story, elementSubfolderById(project))
  if ('rejected' in scope) return []
  return (project.backlog?.stories ?? []).filter((other) => {
    if (other.id === story.id || other.deletedAt) return false
    const otherScope = resolveAllowedScope(other, elementSubfolderById(project))
    return !('rejected' in otherScope) && otherScope.allowedRelativePrefix === scope.allowedRelativePrefix
  })
}

function elementSubfolderById(project: Project): Map<string, string> {
  const map = new Map<string, string>()
  for (const element of project.architecture?.elements ?? []) {
    map.set(element.id, elementSubfolderName(element))
  }
  return map
}

function formatElement(project: Project, elementId: string): string {
  const element = project.architecture?.elements.find((e) => e.id === elementId)
  if (!element) return elementId
  return `${element.id} (${element.kind}): ${element.name} — ${element.responsibility}`
}

function formatRequirements(project: Project, requirementIds: string[]): string {
  const byId = new Map(project.requirements.map((r) => [r.id, r]))
  return requirementIds
    .map((id) => byId.get(id))
    .filter((r): r is NonNullable<typeof r> => r !== undefined)
    .map((r) => `${r.id}: ${r.text}`)
    .join('\n')
}

const SELF_REVIEW_INSTRUCTION = `Before finishing, review your own changes for correctness, and refactor for
clarity. Favour reusing existing code already in this subfolder over
duplicating logic.`

export function buildStoryCodingPrompt(project: Project, story: Story, allowedRelativePrefix: string): string {
  const parts: string[] = []
  parts.push(
    `You may ONLY create or modify files under ${allowedRelativePrefix}/ relative to your working directory — do not touch any file outside that path.`,
  )

  if (story.interfaceElementIds) {
    const [fromId, toId] = story.interfaceElementIds
    parts.push(`This story implements a shared interface between two architecture elements:`)
    parts.push(formatElement(project, fromId))
    parts.push(formatElement(project, toId))
    const contract = project.architecture?.interfaceContracts?.find(
      (c) => [c.fromId, c.toId].sort().join('|') === [fromId, toId].sort().join('|'),
    )
    if (contract && contract.operations.length > 0) {
      parts.push('Interface contract operations:')
      parts.push(
        contract.operations
          .map((op) => `- ${op.name}: ${op.description} (request: ${op.request}; response: ${op.response})`)
          .join('\n'),
      )
    }
  } else if (story.architectureElementId) {
    parts.push('This story belongs to the architecture element:')
    parts.push(formatElement(project, story.architectureElementId))
  }

  parts.push(`Story: ${story.title}\n${story.description}`)

  if (story.requirementIds.length > 0) {
    parts.push('Requirements this story must satisfy:')
    parts.push(formatRequirements(project, story.requirementIds))
  }

  if (story.research) {
    parts.push(`Prior research recommended: ${story.research.recommendation} — ${story.research.rationale}`)
  }

  if (project.codingConventions) {
    parts.push(`Coding conventions to follow:\n${project.codingConventions}`)
  }

  parts.push(SELF_REVIEW_INSTRUCTION)
  return parts.join('\n\n')
}

export async function runCodingForStory(
  project: Project,
  projectDir: string,
  story: Story,
  agentClient: CodingAgentClient,
  options: RunCodingOptions = {},
): Promise<CodingRun> {
  const startedAt = new Date().toISOString()

  if (!isStoryEligibleForCoding(project, story)) {
    return {
      id: `CODINGRUN-${startedAt}`,
      architectureElementId: story.architectureElementId ?? story.id,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: 'rejected-not-eligible',
      diff: '',
      rawLog: "None of this story's requirements are at 'allocated' status — nothing impacted by a failing test or a requirement change, so this module has no pending work for Coding to do.",
      exitCode: null,
      allowedSubfolder: '',
    }
  }

  const scope = resolveAllowedScope(story, elementSubfolderById(project))

  if ('rejected' in scope) {
    return {
      id: `CODINGRUN-${startedAt}`,
      architectureElementId: story.architectureElementId ?? story.id,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: 'rejected-multi-element',
      diff: '',
      rawLog: 'Story resolves to more than one architecture element/interface pair — split it into per-element or per-interface stories before running Coding.',
      exitCode: null,
      allowedSubfolder: '',
    }
  }

  await scaffoldProjectSourceTree(project, projectDir)
  const srcRoot = sourceTreeRoot(projectDir)
  await gitInitIfNeeded(srcRoot)
  const beforeStatus = await gitStatusPorcelain(srcRoot)

  const prompt = buildStoryCodingPrompt(project, story, scope.allowedRelativePrefix)

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
      architectureElementId: story.architectureElementId ?? story.id,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: 'cli-error' satisfies CodingRunStatus,
      diff: '',
      rawLog,
      exitCode,
      allowedSubfolder: scope.allowedRelativePrefix,
    }
  }

  const gateResult = await enforceWriteScope(srcRoot, scope.allowedRelativePrefix, beforeStatus)
  if (!gateResult.ok) {
    const remainingDiff = await gitDiffText(srcRoot)
    return {
      id: `CODINGRUN-${startedAt}`,
      architectureElementId: story.architectureElementId ?? story.id,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: 'rejected-scope',
      diff: remainingDiff,
      rawLog: runResult.rawLog,
      exitCode: runResult.exitCode,
      allowedSubfolder: scope.allowedRelativePrefix,
      rejectedFiles: gateResult.rejectedFiles,
      usage: runResult.usage,
    }
  }

  const diff = await gitDiffText(srcRoot)
  await gitCommitAll(srcRoot, `Coding: ${story.id} ${story.title}`)

  return {
    id: `CODINGRUN-${startedAt}`,
    architectureElementId: story.architectureElementId ?? story.id,
    startedAt,
    finishedAt: new Date().toISOString(),
    status: 'success',
    diff,
    rawLog: runResult.rawLog,
    exitCode: runResult.exitCode,
    allowedSubfolder: scope.allowedRelativePrefix,
    usage: runResult.usage,
  }
}
