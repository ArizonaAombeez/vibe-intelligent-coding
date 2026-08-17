import type { LlmMessage } from './LlmClient.js'
import type { ArchitectureElement, ImportedCodeFile } from './types.js'

// Code alignment analysis (Import Project, REQ-059/REQ-060) — maps each
// imported code file to the architecture element it best corresponds to, or
// flags it as unmapped. Mirrors AUTO_CONFIGURE_SYSTEM_PROMPT's tagged-line
// reply format (see architecture.ts).
export const CODE_ALIGNMENT_SYSTEM_PROMPT = `You are the Architect, comparing an existing (legacy) codebase against the target
architecture that has just been designed for this project. You will be given the
target architecture's elements and a set of existing source files.

For every source file, decide which single architecture element it most closely
corresponds to, and how well it aligns with that element's stated responsibility. Reply
with one line per file, in exactly this format:

MAP: <file path> | <architecture element id, or NONE if no element corresponds> | <aligned|partially-aligned|no-equivalent, or blank if NONE> | <short rationale>

Use "aligned" when the file's existing behaviour already matches the element's
responsibility well. Use "partially-aligned" when the file does related work but would
need real changes to fit the element's responsibility as designed. Use "no-equivalent"
when the file's behaviour has no counterpart in the target architecture (e.g. it
implements something the new design intentionally drops, or does not correspond to any
element's responsibility). Use "NONE" (with the status column left blank) only when you
cannot identify any plausible corresponding element at all. Every file you are given
must get exactly one MAP: line — do not omit any file, and do not invent files that
were not given to you.`

function formatArchitectureElements(elements: ArchitectureElement[]): string {
  return elements.map((e) => `- ${e.id} (${e.name}): ${e.responsibility}`).join('\n')
}

function formatCodeFiles(codeFiles: ImportedCodeFile[]): string {
  return codeFiles.map((f) => `--- ${f.path} ---\n${f.content}`).join('\n\n')
}

export function buildCodeAlignmentPrompt(
  elements: ArchitectureElement[],
  codeFiles: ImportedCodeFile[],
): LlmMessage[] {
  return [
    { role: 'system', content: CODE_ALIGNMENT_SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `Target architecture elements:\n${formatArchitectureElements(elements)}\n\n` +
        `Existing source files:\n${formatCodeFiles(codeFiles)}`,
    },
  ]
}
