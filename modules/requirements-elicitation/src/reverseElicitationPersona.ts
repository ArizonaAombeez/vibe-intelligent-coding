import type { LlmMessage } from './LlmClient.js'
import type { ImportedCodeFile, Requirement } from './types.js'

// Code gap scan (Import Project, REQ-056) — reads existing source files
// against the project's *already-confirmed* requirement set and proposes
// requirements only for behaviour not yet covered. Deliberately not a
// from-scratch reverse elicitation: the intended flow is baseline
// requirements first (from docs/manual entry), then a gap scan against
// that baseline — re-proposing everything the code does regardless of what
// is already confirmed would flood the review queue with duplicates of
// requirements already accepted from documents. Modeled directly on
// GAP_CHECK_SYSTEM_PROMPT's structure (analystPersona.ts) but scanning code
// instead of sweeping the requirement set for internal gaps. Reuses the
// REQUIREMENT: line format so the existing accept/discard flow and
// createRequirementFromForm path handle both.
export const CODE_GAP_SCAN_SYSTEM_PROMPT = `You are the Analyst, scanning an existing codebase for requirement gaps. You will be
given the project's current confirmed requirements and a set of source files. Read the
code and propose a requirement ONLY for behaviour the code implements that is NOT
already covered by one of the existing requirements listed below — do not repeat or
rephrase anything already covered.

Propose each requirement on its own line using exactly this format:

REQUIREMENT: <the requirement text, written as a single clear statement>

Only propose requirements this way when you are confident the statement is atomic (a
single testable statement, not a compound sentence covering multiple behaviours),
is actually supported by the code shown (not inferred or guessed), and is genuinely
missing from the existing requirement set. Do not propose requirements about code
quality, style, or architecture — only observed functional behaviour. Do not comment
on the code outside of REQUIREMENT: lines. If every behaviour you see is already
covered, propose nothing.`

function formatCodeFilesForPrompt(codeFiles: ImportedCodeFile[]): string {
  return codeFiles.map((f) => `--- ${f.path} ---\n${f.content}`).join('\n\n')
}

function formatExistingRequirements(requirements: Requirement[]): string {
  if (requirements.length === 0) return 'No requirements have been elicited yet.'
  return requirements.map((r) => `${r.id}: ${r.text}`).join('\n')
}

// alreadyProposed carries REQUIREMENT: text proposed by earlier batches in
// the same scan (per-file/batched scan mode, codeImport.ts) — folded into
// the "existing" list so the model doesn't re-propose the same gap once per
// batch when the same behaviour is visible from multiple files.
export function buildCodeGapScanPrompt(
  requirements: Requirement[],
  codeFiles: ImportedCodeFile[],
  alreadyProposed: string[] = [],
): LlmMessage[] {
  const existingText =
    alreadyProposed.length === 0
      ? formatExistingRequirements(requirements)
      : `${formatExistingRequirements(requirements)}\n` +
        alreadyProposed.map((text) => `(proposed earlier this scan): ${text}`).join('\n')

  return [
    { role: 'system', content: CODE_GAP_SCAN_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Existing confirmed requirements:\n${existingText}\n\nSource files:\n${formatCodeFilesForPrompt(codeFiles)}`,
    },
  ]
}

// Document import (Import Project, REQ-055) — a supporting document that
// isn't in VIC's own tagged import format (see IMPORT_BLOCK in
// elicitation.ts). Arbitrary document-format normalisation is explicitly
// out of scope (open question in the PRD) — this treats the whole file as
// plain prose and asks the Analyst to extract candidate requirements from
// it, same proposal format as reverse elicitation.
export const DOCUMENT_IMPORT_SYSTEM_PROMPT = `You are the Analyst, extracting candidate requirements from a supporting document
supplied as part of a project import (e.g. a spec, README, or design note). Read the
document and propose one requirement for each distinct piece of intended behaviour it
describes.

Propose each requirement on its own line using exactly this format:

REQUIREMENT: <the requirement text, written as a single clear statement>

Only propose requirements this way when you are confident the statement is atomic (a
single testable statement, not a compound sentence covering multiple behaviours) and
is actually supported by the document text, not inferred or guessed. Do not comment on
the document outside of REQUIREMENT: lines.`

export function buildDocumentImportPrompt(documentPath: string, content: string): LlmMessage[] {
  return [
    { role: 'system', content: DOCUMENT_IMPORT_SYSTEM_PROMPT },
    { role: 'user', content: `--- ${documentPath} ---\n${content}` },
  ]
}
