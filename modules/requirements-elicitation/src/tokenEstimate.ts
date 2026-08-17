import { stripCodeFileContent, type CodeStripOptions } from './codeStrip.js'
import type { ImportedCodeFile, Requirement } from './types.js'

// Rough char-per-token approximation (no tokenizer dependency in this
// module — see module README/design notes) — ~4 chars/token is the
// standard rule of thumb for English prose and close enough for a
// pre-flight "roughly how big is this call" estimate, not an exact bill.
const CHARS_PER_TOKEN = 4

export function estimateTokensForText(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

// Raw context window and the "safe" warning threshold below it, per known
// model key (as passed via LlmCallOptions.model). contextWindow is a
// SHARED budget across input + output tokens (true of GLM/z.ai and every
// other provider here, not two separate allowances) — warnAt is
// deliberately below the raw window to leave room for the model's output
// plus a quality/latency margin (very large prompts degrade both even on
// models that technically accept them), not a hard API-enforced ceiling.
// Scaled to ~80% of each model's real contextWindow rather than a flat
// figure — a flat 128k previously left glm-5.2's 1M window almost entirely
// unused (warnAt was only ~13% of its real capacity) while doing nothing
// wrong for the 128k-window models it was copied from.
export interface ModelContextLimit {
  contextWindow: number
  warnAt: number
}

const WARN_AT_RATIO = 0.8

function withWarnAt(contextWindow: number): ModelContextLimit {
  return { contextWindow, warnAt: Math.round(contextWindow * WARN_AT_RATIO) }
}

const DEFAULT_CONTEXT_LIMIT: ModelContextLimit = withWarnAt(128_000)

const KNOWN_MODEL_CONTEXT_LIMITS: Record<string, ModelContextLimit> = {
  'glm-5.2': withWarnAt(1_000_000),
  'glm-4.7': withWarnAt(200_000),
  'glm-4.7-flash': withWarnAt(200_000),
  'glm-4.5': withWarnAt(128_000),
  'glm-4.5-air': withWarnAt(128_000),
  'glm-4.5-x': withWarnAt(128_000),
  // Claude Code CLI plugin's model keys (settingsManifest.ts) — '' (CLI
  // default) falls through to DEFAULT_CONTEXT_LIMIT since the actual
  // model the CLI resolves to isn't known here.
  opus: withWarnAt(1_000_000),
  sonnet: withWarnAt(1_000_000),
  haiku: withWarnAt(200_000),
}

export function contextLimitForModel(model: string | undefined): ModelContextLimit {
  if (!model) return DEFAULT_CONTEXT_LIMIT
  return KNOWN_MODEL_CONTEXT_LIMITS[model] ?? DEFAULT_CONTEXT_LIMIT
}

export interface TokenEstimate {
  inputTokens: number
  estimatedOutputTokens: number
  totalTokens: number
  contextWindow: number
  warnAt: number
  // True once totalTokens crosses warnAt — the caller (UI) surfaces this as
  // a "you're approaching the context limit" warning before the call runs.
  nearContextLimit: boolean
}

// Estimated output size per requirement note in a batched analysis reply
// (short prose assessment + a SEVERITY line) — derived from typical
// analystNote lengths, not a hard cap the LLM is instructed to obey.
const ESTIMATED_OUTPUT_TOKENS_PER_REQUIREMENT = 60

// Pre-flight estimate for a batched "Review Clarity" call over the given
// requirement ids: the analysis system prompt (sent once, batched) plus
// every targeted requirement's text as input, and a rough per-requirement
// output size. Model is whatever the caller will actually pass as
// LlmCallOptions.model, so the limit reflects the model that will really
// be used — falls back to DEFAULT_CONTEXT_LIMIT for an unrecognised or
// unset model rather than silently assuming a huge window.
export function estimateAnalysisTokens(
  requirements: Requirement[],
  requirementIds: string[],
  systemPromptText: string,
  model?: string,
): TokenEstimate {
  const targeted = requirements.filter((r) => requirementIds.includes(r.id))
  const requirementsText = targeted.map((r) => `${r.id}: ${r.text}`).join('\n')

  const inputTokens =
    estimateTokensForText(systemPromptText) + estimateTokensForText(requirementsText)
  const estimatedOutputTokens = targeted.length * ESTIMATED_OUTPUT_TOKENS_PER_REQUIREMENT
  const totalTokens = inputTokens + estimatedOutputTokens

  const { contextWindow, warnAt } = contextLimitForModel(model)

  return {
    inputTokens,
    estimatedOutputTokens,
    totalTokens,
    contextWindow,
    warnAt,
    nearContextLimit: totalTokens >= warnAt,
  }
}

// Estimated output size per proposed gap requirement — same shape as
// ESTIMATED_OUTPUT_TOKENS_PER_REQUIREMENT but a REQUIREMENT: line plus a
// margin for the model over- or under-proposing per file, not a hard cap.
const ESTIMATED_OUTPUT_TOKENS_PER_FILE = 80

export interface CodeFileTokenEstimate {
  path: string
  tokens: number
}

// One content-mode's worth of sizing (complete files, or a given
// stripCodeFileContent transform applied) — files carries the resulting
// per-file token counts so the UI table updates to match whichever content
// mode is selected, not just the totals.
export interface CodeGapScanContentEstimate {
  files: CodeFileTokenEstimate[]
  fixedOverheadTokens: number
  // One call, every (content-mode-adjusted) file concatenated. Pays
  // fixedOverheadTokens once — see buildCodeGapScanPrompt.
  singleCallTotalTokens: number
  // One call per file (proposeCodeGapRequirementsPerFile). Pays
  // fixedOverheadTokens once PER FILE since every call resends the system
  // prompt + existing requirements — typically larger in total than
  // singleCallTotalTokens despite each individual call being far smaller.
  perFileTotalTokens: number
  perFileCallCount: number
  // Whether singleCallTotalTokens fits under warnAt for this content mode —
  // stripping can turn a "too large" single call into one that fits.
  singleCallFits: boolean
}

// Pre-flight estimate for a Scan Code for Requirement Gaps run, covering
// both independent axes the dialog offers: content ('complete' vs
// 'stripped', per codeStrip.ts's DEFAULT_CODE_STRIP_OPTIONS) and delivery
// ('single-call' vs 'per-file', per CodeGapScanContentEstimate above) — so
// the UI can show all four combinations' numbers without a round trip per
// toggle change. contextWindow/warnAt are shared across content modes since
// they depend only on the model, not what's sent. model echoes back
// whatever was actually passed in (the persona's resolved model, per the
// caller's resolvePersonaLlmOptions) — undefined means no model could be
// resolved at all, in which case contextWindow/warnAt fall back to
// DEFAULT_CONTEXT_LIMIT and the UI should say so rather than implying a
// specific model's window.
export interface CodeGapScanTokenEstimate {
  complete: CodeGapScanContentEstimate
  stripped: CodeGapScanContentEstimate
  contextWindow: number
  warnAt: number
  model?: string
}

function estimateForFiles(
  codeFiles: ImportedCodeFile[],
  fixedOverheadTokens: number,
  warnAt: number,
): CodeGapScanContentEstimate {
  const files = codeFiles.map((f) => ({
    path: f.path,
    tokens: estimateTokensForText(f.content),
  }))

  const codeTokens = files.reduce((sum, f) => sum + f.tokens, 0)
  const estimatedOutputTokens = codeFiles.length * ESTIMATED_OUTPUT_TOKENS_PER_FILE

  const singleCallTotalTokens = fixedOverheadTokens + codeTokens + estimatedOutputTokens
  const perFileTotalTokens = fixedOverheadTokens * codeFiles.length + codeTokens + estimatedOutputTokens

  return {
    files,
    fixedOverheadTokens,
    singleCallTotalTokens,
    perFileTotalTokens,
    perFileCallCount: codeFiles.length,
    singleCallFits: singleCallTotalTokens < warnAt,
  }
}

export function estimateCodeGapScanTokens(
  codeFiles: ImportedCodeFile[],
  requirements: Requirement[],
  systemPromptText: string,
  stripOptions: CodeStripOptions,
  model?: string,
): CodeGapScanTokenEstimate {
  const requirementsText = formatRequirementsForEstimate(requirements)
  const fixedOverheadTokens = estimateTokensForText(systemPromptText) + estimateTokensForText(requirementsText)

  const { contextWindow, warnAt } = contextLimitForModel(model)

  const strippedFiles = codeFiles.map((f) => ({
    path: f.path,
    content: stripCodeFileContent(f.content, stripOptions),
  }))

  return {
    complete: estimateForFiles(codeFiles, fixedOverheadTokens, warnAt),
    stripped: estimateForFiles(strippedFiles, fixedOverheadTokens, warnAt),
    contextWindow,
    warnAt,
    model,
  }
}

function formatRequirementsForEstimate(requirements: Requirement[]): string {
  if (requirements.length === 0) return 'No requirements have been elicited yet.'
  return requirements.map((r) => `${r.id}: ${r.text}`).join('\n')
}
