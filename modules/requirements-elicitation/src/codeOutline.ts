import type { ImportedCodeFile } from './types.js'

// Structure-only pre-filter for the code gap scan (REQ-056) — a free,
// non-LLM heuristic for ranking imported files by how much they look like
// they carry actual behaviour worth a full-content LLM scan, versus
// boilerplate/config/generated noise. NOT a scan mode of its own: an
// outline (signatures with bodies stripped) tells the model what exists,
// not what it does, so it can't reliably produce REQUIREMENT: text — the
// interesting behaviour (validation rules, branching, error conditions) is
// almost always inside the stripped bodies. Its only job is helping the
// per-file batched scan (proposeCodeGapRequirementsPerFile) skip files
// unlikely to be worth a call, on large imports where scanning every file
// in full is too slow/costly. Heuristic, not exhaustive — false negatives
// (a real requirement living in a file this scores low) are expected and
// acceptable since this is an opt-in filter, not the scan itself.
const LOW_SIGNAL_PATH_PATTERNS = [
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)node_modules\//,
  /(^|\/)\.next\//,
  /(^|\/)coverage\//,
  /\.min\.(js|css)$/,
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /\.(lock|log)$/,
  /\.(svg|png|jpg|jpeg|gif|ico|woff2?|ttf|eot)$/,
  /\.d\.ts$/,
  /(^|\/)(test|tests|__tests__|__mocks__|fixtures)\//,
  /\.(test|spec)\.[jt]sx?$/,
]

// Rough signal that a file's body carries actual logic — conditionals, loops,
// error handling, or validation — versus pure data/type declarations.
const LOGIC_KEYWORD_PATTERN = /\b(if|else|for|while|switch|throw|catch|try|return)\b/g

export interface CodeFileOutlineScore {
  path: string
  // Lower is less likely to be worth a full scan. Not a probability — only
  // meaningful relative to other files in the same batch.
  signalScore: number
  lowSignal: boolean
}

function isLowSignalPath(path: string): boolean {
  return LOW_SIGNAL_PATH_PATTERNS.some((pattern) => pattern.test(path))
}

// Counts logic-keyword occurrences per 100 lines — a crude but cheap proxy
// for "how much branching/error-handling behaviour is in here" without
// parsing the file (this module has no per-language parser dependency,
// mirroring tokenEstimate.ts's char-count-not-tokenizer approach).
function logicDensity(content: string): number {
  const lineCount = Math.max(1, content.split('\n').length)
  const matches = content.match(LOGIC_KEYWORD_PATTERN)
  return ((matches?.length ?? 0) / lineCount) * 100
}

export function scoreCodeFilesForGapScan(codeFiles: ImportedCodeFile[]): CodeFileOutlineScore[] {
  return codeFiles.map((f) => {
    if (isLowSignalPath(f.path)) {
      return { path: f.path, signalScore: 0, lowSignal: true }
    }
    const signalScore = logicDensity(f.content)
    return { path: f.path, signalScore, lowSignal: false }
  })
}

// Filters codeFiles down to those worth a full-content gap-scan call,
// dropping recognisably-generated/vendored/asset paths outright and (if
// maxFiles is given) keeping only the highest-signal remainder — e.g. to
// cap a per-file batched scan at a fixed number of LLM calls on a very
// large import. Order of the input is preserved among kept files.
export function filterCodeFilesForGapScan(
  codeFiles: ImportedCodeFile[],
  maxFiles?: number,
): ImportedCodeFile[] {
  const scores = scoreCodeFilesForGapScan(codeFiles)
  const withoutLowSignal = codeFiles.filter((_, i) => !scores[i].lowSignal)

  if (maxFiles === undefined || withoutLowSignal.length <= maxFiles) return withoutLowSignal

  const scoreByPath = new Map(scores.map((s) => [s.path, s.signalScore]))
  return [...withoutLowSignal]
    .sort((a, b) => (scoreByPath.get(b.path) ?? 0) - (scoreByPath.get(a.path) ?? 0))
    .slice(0, maxFiles)
    .sort((a, b) => codeFiles.indexOf(a) - codeFiles.indexOf(b))
}
