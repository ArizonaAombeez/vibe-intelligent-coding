import { buildCodeAlignmentPrompt } from './codeAlignmentPersona.js'
import type { LlmCallOptions, LlmClient, LlmUsage } from './LlmClient.js'
import type { AlignmentStatus, CodeAlignmentMapping, Project } from './types.js'

const MAP_LINE = /^MAP:\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*(.+)$/gm

const VALID_STATUSES = new Set<AlignmentStatus>(['aligned', 'partially-aligned', 'no-equivalent'])

function parseMapLines(reply: string): Map<string, CodeAlignmentMapping> {
  const byFile = new Map<string, CodeAlignmentMapping>()
  for (const m of reply.matchAll(MAP_LINE)) {
    const filePath = m[1].trim()
    const elementId = m[2].trim()
    const statusText = m[3].trim()
    const rationale = m[4].trim()
    if (elementId === '' || elementId === 'NONE') {
      byFile.set(filePath, { filePath, architectureElementId: null, status: null, rationale })
      continue
    }
    const status = VALID_STATUSES.has(statusText as AlignmentStatus) ? (statusText as AlignmentStatus) : null
    byFile.set(filePath, { filePath, architectureElementId: elementId, status, rationale })
  }
  return byFile
}

export interface RunCodeAlignmentAnalysisResult {
  mappings: CodeAlignmentMapping[]
  usage?: LlmUsage
}

// Code alignment analysis (Import Project, REQ-059/REQ-060) — one LLM call
// comparing every imported code file against the confirmed architecture's
// elements. Every code file gets exactly one CodeAlignmentMapping in the
// result, even if the LLM reply never mentions it (REQ-060: unmapped code
// must be flagged for human review, never silently dropped) — those get
// architectureElementId: null with a generic rationale.
export async function runCodeAlignmentAnalysis(
  project: Project,
  llmClient: LlmClient,
  llmOptions?: LlmCallOptions,
): Promise<RunCodeAlignmentAnalysisResult> {
  if (!project.architecture) {
    throw new Error('Project has no architecture — select an Architecture type first')
  }
  if (!project.importedCode || project.importedCode.files.length === 0) {
    throw new Error('Project has no imported code — import a codebase first')
  }

  const { architecture, importedCode } = project
  const messages = buildCodeAlignmentPrompt(architecture.elements, importedCode.files)
  const result = await llmClient.chat(messages, llmOptions)
  const byFile = parseMapLines(result.content)

  const mappings: CodeAlignmentMapping[] = importedCode.files.map((file) => {
    const found = byFile.get(file.path)
    if (found) return found
    return {
      filePath: file.path,
      architectureElementId: null,
      status: null,
      rationale: 'Not addressed in the alignment analysis reply — flagged for manual review.',
    }
  })

  project.codeAlignment = { mappings, checkedAt: new Date().toISOString() }

  return { mappings, usage: result.usage }
}
