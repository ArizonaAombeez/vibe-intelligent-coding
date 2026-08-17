import type { LlmMessage } from './LlmClient.js'
import type { ImportedCodeFile, Requirement } from './types.js'

// "Analyse Code" (Dev/Coding phase) — checks the code actually written for
// an architecture element against the specific requirements currently
// allocated to it. Mirrors CODE_ALIGNMENT_SYSTEM_PROMPT's tagged-line reply
// format (see codeAlignmentPersona.ts), but requirement-by-requirement
// rather than file-by-file, and against Coding-phase output rather than
// Import Project's legacy codebase.
export const ELEMENT_CODE_CHECK_SYSTEM_PROMPT = `You are reviewing code that was written to implement a specific architecture element,
checking whether it actually satisfies the requirements currently allocated to that
element. You will be given the element's allocated requirements and the current
contents of every file in the element's scoped folder.

For every requirement, decide whether the code satisfies it. Reply with one line per
requirement, in exactly this format:

CHECK: <requirement id> | <satisfied|partial|not-satisfied> | <short rationale>

Use "satisfied" when the code fully implements what the requirement describes. Use
"partial" when the code makes a genuine attempt but is missing part of what the
requirement describes, or implements it in a way that doesn't fully match (e.g. wrong
behaviour, wrong size/position, an edge case left unhandled). Use "not-satisfied" when
the code does not address the requirement at all, or does something unrelated. Base
your verdict only on what the code actually does, not on comments or naming that merely
claim it does something. Every requirement you are given must get exactly one CHECK:
line — do not omit any, and do not invent requirement ids that were not given to you.`

function formatRequirements(requirements: Requirement[]): string {
  return requirements.map((r) => `${r.id}: ${r.text}`).join('\n')
}

function formatCodeFiles(codeFiles: ImportedCodeFile[]): string {
  return codeFiles.map((f) => `--- ${f.path} ---\n${f.content}`).join('\n\n')
}

export function buildElementCodeCheckPrompt(
  elementName: string,
  requirements: Requirement[],
  codeFiles: ImportedCodeFile[],
): LlmMessage[] {
  const codeSection =
    codeFiles.length > 0
      ? formatCodeFiles(codeFiles)
      : '(No files exist yet in this element\'s scoped folder.)'
  return [
    { role: 'system', content: ELEMENT_CODE_CHECK_SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `Architecture element: ${elementName}\n\n` +
        `Requirements currently allocated to this element:\n${formatRequirements(requirements)}\n\n` +
        `Current code in this element's scoped folder:\n${codeSection}`,
    },
  ]
}
