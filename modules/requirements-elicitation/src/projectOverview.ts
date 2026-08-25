import type { LlmCallOptions, LlmClient, LlmUsage } from './LlmClient.js'
import type { Project } from './types.js'

const SYSTEM_PROMPT = `You are the Architect. Given a project's requirements and (if present) its
architecture elements, write its Project Overview.

Reply using exactly this format, nothing else:

DESCRIPTION: <one or two sentences on what this app is and the tech stack it's built with>
RUN: <the build/run command(s), e.g. "npm install && npm run dev, starts on http://localhost:3000">

If the requirements/architecture don't make the tech stack or run command obvious, give your best
reasonable default for the kind of project described (e.g. a Node/React web app) rather than leaving
either line blank.`

function formatRequirements(project: Project): string {
  if (project.requirements.filter((r) => !r.deletedAt).length === 0) return '(no requirements yet)'
  return project.requirements
    .filter((r) => !r.deletedAt)
    .map((r) => `${r.id}: ${r.text}`)
    .join('\n')
}

function formatElements(project: Project): string {
  const elements = project.architecture?.elements ?? []
  if (elements.length === 0) return '(no architecture elements yet)'
  return elements.map((e) => `- ${e.name} (${e.kind}): ${e.responsibility}`).join('\n')
}

export interface GenerateProjectOverviewResult {
  description: string
  runInstructions: string
  usage?: LlmUsage
}

// "Auto Populate" (Architecture tab, Project Overview panel) — one LLM call
// drafting the free-text description/runInstructions from whatever
// requirements and architecture elements already exist. Always overwrites
// both fields; the caller (UI) is responsible for confirming with the user
// since this replaces any existing text.
export async function generateProjectOverview(
  project: Project,
  llmClient: LlmClient,
  llmOptions?: LlmCallOptions,
): Promise<GenerateProjectOverviewResult> {
  const userPrompt = `Requirements:\n${formatRequirements(project)}\n\nArchitecture elements:\n${formatElements(project)}`
  const messages = [
    { role: 'system' as const, content: SYSTEM_PROMPT },
    { role: 'user' as const, content: userPrompt },
  ]
  const result = await llmClient.chat(messages, llmOptions)

  const descriptionMatch = result.content.match(/DESCRIPTION:\s*(.+)/)
  const runMatch = result.content.match(/RUN:\s*(.+)/)

  return {
    description: descriptionMatch ? descriptionMatch[1].trim() : '',
    runInstructions: runMatch ? runMatch[1].trim() : '',
    usage: result.usage,
  }
}
