import { buildCodeGapScanPrompt, buildDocumentImportPrompt } from './reverseElicitationPersona.js'
import { activeRequirements, importRequirementsFromText, countImportBlocks } from './elicitation.js'
import { stripCodeFiles } from './codeStrip.js'
import type { LlmCallOptions, LlmClient, LlmUsage } from './LlmClient.js'
import type { CodeStripOptions } from './codeStrip.js'
import type { ImportedCodeFile, Project } from './types.js'

// A supporting file that isn't source code, from an Import Project upload
// (REQ-055) — may or may not already be in VIC's own tagged import format
// (see IMPORT_BLOCK in elicitation.ts).
export interface ImportedDocumentFile {
  path: string
  content: string
}

export interface CodeImportBundle {
  codeFiles: ImportedCodeFile[]
  documentFiles: ImportedDocumentFile[]
}

// Code gap scan (REQ-056) — one LLM call over every imported code file,
// scoped against the project's current confirmed requirements, proposing
// requirements only for behaviour not already covered. Returns proposals
// only; the caller commits accepted ones via createRequirementFromForm
// with provenance 'reverse-elicited-code', same "propose, human accepts"
// shape as chatWithAnalyst. No-op (no LLM call) when there are no code
// files, mirroring checkConflicts/checkGaps' empty-set short circuit.
// Intended to run after a baseline requirement set already exists (from
// document import and/or manual entry) — see buildCodeGapScanPrompt.
export interface ProposeCodeGapRequirementsResult {
  proposedRequirements: string[]
  usage?: LlmUsage
}

const REQUIREMENT_LINE = /^REQUIREMENT:\s*(.+)$/gm

function extractProposedRequirements(reply: string): string[] {
  return Array.from(reply.matchAll(REQUIREMENT_LINE), (m) => m[1].trim())
}

export async function proposeCodeGapRequirements(
  project: Project,
  llmClient: LlmClient,
  codeFiles: ImportedCodeFile[],
  llmOptions?: LlmCallOptions,
  stripOptions?: CodeStripOptions,
): Promise<ProposeCodeGapRequirementsResult> {
  if (codeFiles.length === 0) return { proposedRequirements: [] }

  const files = stripOptions ? stripCodeFiles(codeFiles, stripOptions) : codeFiles
  const messages = buildCodeGapScanPrompt(activeRequirements(project), files)
  const result = await llmClient.chat(messages, llmOptions)
  return {
    proposedRequirements: extractProposedRequirements(result.content),
    usage: result.usage,
  }
}

function addUsage(a: LlmUsage | undefined, b: LlmUsage | undefined): LlmUsage | undefined {
  if (!a) return b
  if (!b) return a
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  }
}

// Per-file batched code gap scan — one LLM call per file (REQ-056 "one call
// per file" mode), instead of proposeCodeGapRequirements' single call over
// every file concatenated. Exists because a large imported codebase can
// exceed the target model's context window in one call (see GLM's
// "Prompt 超长" / prompt-too-long 400); scanning file by file has no such
// ceiling, at the cost of losing cross-file context and running N LLM calls
// instead of one. Each file's call is told about proposals from earlier
// files in the same scan (not just the project's already-confirmed
// requirements) so the same behaviour visible from multiple files isn't
// proposed once per file — see buildCodeGapScanPrompt's alreadyProposed
// param. onFileScanned lets the caller stream per-file progress to the UI
// since this can be many sequential calls.
export async function proposeCodeGapRequirementsPerFile(
  project: Project,
  llmClient: LlmClient,
  codeFiles: ImportedCodeFile[],
  llmOptions?: LlmCallOptions,
  onFileScanned?: (path: string, index: number, total: number) => void,
  stripOptions?: CodeStripOptions,
): Promise<ProposeCodeGapRequirementsResult> {
  if (codeFiles.length === 0) return { proposedRequirements: [] }

  const files = stripOptions ? stripCodeFiles(codeFiles, stripOptions) : codeFiles
  const requirements = activeRequirements(project)
  const proposed: string[] = []
  let usage: LlmUsage | undefined

  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    const messages = buildCodeGapScanPrompt(requirements, [file], proposed)
    const result = await llmClient.chat(messages, llmOptions)
    proposed.push(...extractProposedRequirements(result.content))
    usage = addUsage(usage, result.usage)
    onFileScanned?.(file.path, i + 1, files.length)
  }

  return { proposedRequirements: proposed, usage }
}

// Document import (REQ-055) — each supporting document either matches
// VIC's own tagged import format (imported directly, no LLM call, via the
// existing importRequirementsFromText) or is treated as free prose and run
// through a one-call-per-document LLM extraction pass. Unlike
// importRequirementsFromText's format path (which commits immediately),
// the free-prose path only proposes — the caller commits via
// createRequirementFromForm with provenance 'imported-document'.
export interface ImportDocumentsResult {
  // Requirements committed immediately because the document was already in
  // VIC's tagged format — provenance 'imported-document' was already
  // stamped on these by the caller before this returns.
  committedRequirementTexts: string[]
  // Requirements proposed from free-prose documents, awaiting accept/discard.
  proposedRequirements: string[]
  usage?: LlmUsage
}

function looksLikeTaggedImportFormat(content: string): boolean {
  return /^[A-Za-z][\w-]*_?\d+\s*\n[\s\S]*?\n##END_OF_REQ\s*$/m.test(content)
}

export async function importDocumentsAsRequirements(
  project: Project,
  llmClient: LlmClient,
  documentFiles: ImportedDocumentFile[],
  reserveSeqBlock: (count: number) => Promise<number>,
  llmOptions?: LlmCallOptions,
): Promise<ImportDocumentsResult> {
  const committed: string[] = []
  const proposed: string[] = []
  let usage: LlmUsage | undefined

  for (const doc of documentFiles) {
    if (looksLikeTaggedImportFormat(doc.content)) {
      const seqStart = await reserveSeqBlock(countImportBlocks(doc.content))
      const created = importRequirementsFromText(project, doc.content, seqStart)
      for (const requirement of created) {
        requirement.provenance = 'imported-document'
        committed.push(requirement.text)
      }
      continue
    }

    if (!doc.content.trim()) continue

    const messages = buildDocumentImportPrompt(doc.path, doc.content)
    const result = await llmClient.chat(messages, llmOptions)
    proposed.push(...extractProposedRequirements(result.content))
    if (result.usage) {
      usage = usage
        ? {
            promptTokens: usage.promptTokens + result.usage.promptTokens,
            completionTokens: usage.completionTokens + result.usage.completionTokens,
            totalTokens: usage.totalTokens + result.usage.totalTokens,
          }
        : result.usage
    }
  }

  return { committedRequirementTexts: committed, proposedRequirements: proposed, usage }
}
