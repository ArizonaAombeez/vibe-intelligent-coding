import { buildElementCodeCheckPrompt } from './elementCodeCheckPersona.js'
import type { LlmCallOptions, LlmClient, LlmUsage } from './LlmClient.js'
import type { ElementRequirementCoverage, ImportedCodeFile, Project, Requirement, RequirementCoverageStatus } from './types.js'

const CHECK_LINE = /^CHECK:\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*(.+)$/gm

const VALID_STATUSES = new Set<RequirementCoverageStatus>(['satisfied', 'partial', 'not-satisfied'])

function parseCheckLines(reply: string): Map<string, ElementRequirementCoverage> {
  const byRequirement = new Map<string, ElementRequirementCoverage>()
  for (const m of reply.matchAll(CHECK_LINE)) {
    const requirementId = m[1].trim()
    const statusText = m[2].trim()
    const rationale = m[3].trim()
    const status = VALID_STATUSES.has(statusText as RequirementCoverageStatus)
      ? (statusText as RequirementCoverageStatus)
      : 'not-satisfied'
    byRequirement.set(requirementId, { requirementId, status, rationale })
  }
  return byRequirement
}

export interface RunElementCodeCheckResult {
  coverage: ElementRequirementCoverage[]
  usage?: LlmUsage
}

// "Analyse Code" (Dev/Coding phase) — one LLM call comparing the code
// currently in an architecture element's scoped folder against the live
// list of requirements currently allocated to it. Caller passes the
// requirement list directly (queried live from the element's allocation,
// via architectureElements.includes(elementId)) since there's no Story to
// derive it from anymore. Every given requirement gets exactly one
// ElementRequirementCoverage entry, even if the LLM reply never mentions it
// (same "never silently drop" guarantee as runCodeAlignmentAnalysis) —
// those fall back to 'not-satisfied' with a generic rationale, since an
// unaddressed requirement is a gap to surface, not something to hide.
export async function runElementCodeCheck(
  project: Project,
  architectureElementId: string,
  requirements: Requirement[],
  codeFiles: ImportedCodeFile[],
  llmClient: LlmClient,
  llmOptions?: LlmCallOptions,
): Promise<RunElementCodeCheckResult> {
  if (requirements.length === 0) {
    throw new Error('This element has no active requirements to check code against.')
  }

  const element = project.architecture?.elements.find((e) => e.id === architectureElementId)
  const elementName = element?.name ?? architectureElementId

  const messages = buildElementCodeCheckPrompt(elementName, requirements, codeFiles)
  const result = await llmClient.chat(messages, llmOptions)
  const byRequirement = parseCheckLines(result.content)

  const coverage: ElementRequirementCoverage[] = requirements.map((requirement) => {
    const found = byRequirement.get(requirement.id)
    if (found) return found
    return {
      requirementId: requirement.id,
      status: 'not-satisfied',
      rationale: 'Not addressed in the analysis reply — flagged for manual review.',
    }
  })

  const check = { architectureElementId, coverage, checkedAt: new Date().toISOString() }
  project.elementCodeChecks = [
    ...(project.elementCodeChecks ?? []).filter((c) => c.architectureElementId !== architectureElementId),
    check,
  ]

  return { coverage, usage: result.usage }
}
