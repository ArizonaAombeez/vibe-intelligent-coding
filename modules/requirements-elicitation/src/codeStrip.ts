import type { ImportedCodeFile } from './types.js'

// Content-shrinking transforms for a code gap scan (REQ-056) — each an
// independent, opt-in toggle rather than one "stripped" mode, since each
// removes something different with a very different token/value tradeoff.
// Applied to a file's content BEFORE it goes into a gap-scan prompt
// (single-call concatenation or per-file — see codeImport.ts); orthogonal
// to codeOutline.ts's filterCodeFilesForGapScan, which drops whole files
// rather than editing what's kept.
//
// Tradeoffs, in order of how safe they are to enable:
//  - stripBlankLines: pure formatting noise, no semantic content lost.
//    Modest savings (roughly 5-15% on typically-formatted source), no
//    downside for gap-finding. Default ON.
//  - stripComments: comments frequently state the business rule directly
//    ("// reject if under 18 — COPPA") in a way the code alone doesn't
//    make obvious — removing them can make the model MISS real gaps, not
//    just save tokens. Bigger savings than blank lines, but at a real
//    accuracy cost. Default OFF, opt-in only.
//  - stripBodies: keeps only signatures/imports/class shells, discards
//    every function/method body. Biggest savings by far, but the
//    interesting behaviour a gap scan is looking for (validation rules,
//    branching, error handling) lives almost entirely in bodies — a
//    signature alone rarely supports a confident REQUIREMENT: line. Same
//    "outline" idea as codeOutline.ts's file-level filter, applied
//    within a file instead of across files. Default OFF, opt-in only,
//    and the weakest of the three for this specific task.
export interface CodeStripOptions {
  stripBlankLines: boolean
  stripComments: boolean
  stripBodies: boolean
}

export const DEFAULT_CODE_STRIP_OPTIONS: CodeStripOptions = {
  stripBlankLines: true,
  stripComments: false,
  stripBodies: false,
}

// Line and block comments across the C-family/JS/TS-like languages this
// tool targets — not a full per-language parser (mirrors tokenEstimate.ts's
// char-count-not-tokenizer stance elsewhere in this module). Best-effort:
// can mis-strip a "//" or "/*" inside a string literal, acceptable for an
// opt-in token-saving heuristic that the user can simply not enable.
const LINE_COMMENT = /\/\/.*$/gm
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g
const HASH_COMMENT = /(^|\s)#(?!!).*$/gm

function stripComments(content: string): string {
  return content.replace(BLOCK_COMMENT, '').replace(LINE_COMMENT, '').replace(HASH_COMMENT, '$1')
}

function stripBlankLines(content: string): string {
  return content
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .join('\n')
}

// Crude brace-depth-based body remover for C-family/JS/TS-like source: once
// a line opens a block (ends in `{`), everything up to the matching close
// at the same depth is discarded and replaced with `{ ... }`. Deliberately
// simple (no real parser) — good enough for the "how much could this save,
// is it worth it" estimate this feature exists to inform, not a
// correctness-critical transform (the model only ever sees this as
// additional context, never as something re-emitted verbatim). Falls back
// to returning the content unchanged for files with no braces at all
// (e.g. Python) rather than mangling them.
function stripBodies(content: string): string {
  if (!content.includes('{')) return content

  let result = ''
  let depth = 0
  let i = 0
  while (i < content.length) {
    const ch = content[i]
    if (ch === '{') {
      if (depth === 0) {
        result += '{ ... }'
        depth = 1
        let inner = 1
        i++
        while (i < content.length && inner > 0) {
          if (content[i] === '{') inner++
          else if (content[i] === '}') inner--
          i++
        }
        depth = 0
        continue
      }
    } else {
      result += ch
    }
    i++
  }
  return result
}

export function stripCodeFileContent(content: string, options: CodeStripOptions): string {
  let result = content
  if (options.stripComments) result = stripComments(result)
  if (options.stripBodies) result = stripBodies(result)
  if (options.stripBlankLines) result = stripBlankLines(result)
  return result
}

export function stripCodeFiles(
  codeFiles: ImportedCodeFile[],
  options: CodeStripOptions,
): ImportedCodeFile[] {
  if (!options.stripBlankLines && !options.stripComments && !options.stripBodies) return codeFiles
  return codeFiles.map((f) => ({ path: f.path, content: stripCodeFileContent(f.content, options) }))
}
