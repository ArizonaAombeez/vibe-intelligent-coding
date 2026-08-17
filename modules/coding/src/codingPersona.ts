import type { LlmMessage, Project } from 'vic-requirements-elicitation'

// Dev chat (Area D) — open-ended chat with the Dev persona, mirrors
// buildAnalystChatMessages/buildArchitectChatMessages/buildPlanningChatMessages.
// Deliberately never proposes a change itself — Coding's actual work
// product (a diff) only ever comes from runCodingForElement's agentic CLI
// run under the write-scope gate (scopeGate.ts), never from this
// LlmClient-backed chat path. Dev chat exists purely to let the human
// discuss an architecture element or a run's diff/log with the Dev persona
// before or after triggering a real Coding run.
export const DEFAULT_DEV_SYSTEM_PROMPT = `You are Dev, responsible for the Coding & Review-Rework stage of a software
project. You help the user think through implementation approach, discuss an
architecture element before it's coded, or talk through a completed Coding
run's diff or raw log (including a rejected/failed run).

You do not write or modify code yourself in this conversation — actual code
changes only happen via a "Run Coding" action, which invokes an agentic CLI
tool under a strict write-scope gate, not this chat. Just respond
conversationally: clarify ambiguity, discuss trade-offs, help interpret a
diff or error, or suggest what to try differently on the next Coding run.`

// Formats the element + its live-queried allocated requirements as chat
// context — mirrors runCoding.ts's own prompt-building approach (live
// query, not a cached/derived list) so Dev chat and Run Coding always agree
// on what's currently allocated to this element.
export function formatElementContext(project: Project, architectureElementId: string): string {
  const element = project.architecture?.elements.find((e) => e.id === architectureElementId)
  if (!element) return architectureElementId
  const requirements = project.requirements.filter(
    (r) => !r.deletedAt && r.architectureElements.includes(architectureElementId),
  )
  const reqText =
    requirements.length > 0
      ? requirements.map((r) => `${r.id}: ${r.text}`).join('\n')
      : '(no requirements currently allocated)'
  return `${element.id}: ${element.name} — ${element.responsibility}\nAllocated requirements:\n${reqText}`
}

export interface CodeContextFile {
  path: string
  content: string
}

// Total character budget across all included files, applied AFTER
// individual files are read in full — a rough proxy for a token cap (~4
// chars/token) that keeps an opt-in "whole project" scope from silently
// exploding the request. Files are included whole, in order, until the
// budget is exhausted; nothing is included partially, so the model never
// sees a file truncated mid-line, which would invite it to reason about
// code that isn't actually there.
const CODE_CONTEXT_CHAR_BUDGET = 40_000

function formatCodeContext(files: CodeContextFile[]): string | null {
  if (files.length === 0) return null
  const included: CodeContextFile[] = []
  let used = 0
  let omitted = 0
  for (const file of files) {
    if (used + file.content.length > CODE_CONTEXT_CHAR_BUDGET) {
      omitted++
      continue
    }
    included.push(file)
    used += file.content.length
  }
  const body = included.map((f) => `--- ${f.path} ---\n${f.content}`).join('\n\n')
  const omittedNote = omitted > 0 ? `\n\n(${omitted} additional file(s) omitted — over the context budget)` : ''
  return `Source files:\n\n${body}${omittedNote}`
}

export function buildCodingChatMessages(
  project: Project | null,
  architectureElementId: string | null,
  userMessage: string,
  systemPrompt: string = DEFAULT_DEV_SYSTEM_PROMPT,
  codeFiles?: CodeContextFile[],
): LlmMessage[] {
  const context =
    project && architectureElementId
      ? `Architecture element in focus:\n${formatElementContext(project, architectureElementId)}`
      : 'No architecture element currently selected.'
  const codeContext = codeFiles ? formatCodeContext(codeFiles) : null

  const messages: LlmMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'system', content: context },
  ]
  if (codeContext) messages.push({ role: 'system', content: codeContext })
  messages.push({ role: 'user', content: userMessage })
  return messages
}
