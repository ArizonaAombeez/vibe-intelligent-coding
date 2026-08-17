import type { AnalystSeverity, QualityScore, QualityScoreDeduction } from './types.js'

// Deterministic, local (non-LLM) requirement quality heuristic, derived
// from a mechanically-checkable subset of the INCOSE Guide for Writing
// Requirements. This is intentionally coarse — full INCOSE rule
// compliance (e.g. R31 "solution-free", R4 "defined terms exist in a
// glossary") requires semantic understanding a regex cannot provide.
// This is a fast, transparent, zero-cost heuristic surfacing the most
// common phrasing problems, not a substitute for human review or a
// claim of full 42-rule coverage.

interface Rule {
  name: string
  description: string
  amount: number
  test: (text: string) => boolean
}

const RULES: Rule[] = [
  {
    name: 'Vague terms',
    description: 'INCOSE R7 — contains a subjective/unmeasurable word (e.g. "reasonable", "fast").',
    amount: 1,
    test: (text) =>
      /\b(some|adequate|reasonable|sufficient|fast|efficient|user-friendly|reliable|robust|flexible|easy|simple|appropriate)\b/i.test(
        text,
      ),
  },
  {
    name: 'Escape clauses',
    description: 'INCOSE R8 — contains a loophole phrase (e.g. "where possible", "if necessary").',
    amount: 1,
    test: (text) =>
      /\b(where possible|as appropriate|if necessary|if applicable|as needed|to the extent)\b/i.test(
        text,
      ),
  },
  {
    name: 'Open-ended clauses',
    description: 'INCOSE R9 — contains an open-ended qualifier (e.g. "etc.", "such as").',
    amount: 1,
    test: (text) => /\b(etc\.?|and\/or|such as|including but not limited to)\b/i.test(text),
  },
  {
    name: 'Superfluous infinitives',
    description: 'INCOSE R10 — "shall be able to" / "shall be capable of" adds ambiguity about conditions.',
    amount: 0.5,
    test: (text) => /\bshall be (able to|capable of)\b/i.test(text),
  },
  {
    name: 'Ambiguous pronoun',
    description:
      'INCOSE R24 — contains a pronoun ("it", "they", "this", "that") that may lack a clear antecedent. Coarse check — flagged whenever present.',
    amount: 0.5,
    test: (text) => /\b(it|they|this|that)\b/i.test(text),
  },
  {
    name: 'Unachievable absolutes',
    description: 'INCOSE R26 — contains an absolute term (e.g. "always", "100%") that may be unverifiable.',
    amount: 0.5,
    test: (text) => /\b(100%|always|never|all users|every time)\b/i.test(text),
  },
  {
    name: 'Oblique symbol',
    description: 'INCOSE R17 — a slash between words (e.g. "user/admin") has multiple possible readings.',
    amount: 0.5,
    test: (text) => /\w\/\w/.test(text),
  },
  {
    name: 'Not a "shall" statement',
    description: 'EARS baseline — no "shall" present; not phrased as a testable requirement statement.',
    amount: 1,
    test: (text) => !/\bshall\b/i.test(text),
  },
  {
    name: 'Speculative/non-mandatory language',
    description:
      'EARS baseline — a modal verb ("might", "may", "could", "should") makes the system response optional or non-deterministic instead of mandatory and testable.',
    amount: 1,
    test: (text) => /\b(might|may|could|should)\b/i.test(text),
  },
  {
    name: 'Compound/multiple thoughts',
    description: 'INCOSE R18/R19 — multiple "and"/"or" conjunctions suggest more than one requirement bundled together.',
    amount: 1,
    test: (text) => {
      const matches = text.match(/\b(and|or)\b/gi)
      return (matches?.length ?? 0) >= 2
    },
  },
]

const SCORE_FLOOR = 1
const SCORE_CEILING = 5

// Applied on top of the regex deductions when an Analyst LLM review has
// run (see analyseRequirements/parseAnalystSeverity) — lets the LLM's
// judgement catch phrasing problems (undefined domain terms, speculative
// wording, missing EARS trigger) the mechanical rules have no check for.
// "good" adds nothing; the regex rules already speak for a clean text.
const SEVERITY_PENALTY: Record<AnalystSeverity, number> = {
  good: 0,
  fair: 1,
  poor: 2,
}

function roundToHalf(value: number): number {
  return Math.round(value * 2) / 2
}

// Pure, synchronous, zero-IO — computes a 1-5 score for a requirement's
// text plus any conflict penalty. Called after Review Clarity (text-only,
// conflictCount defaults to the requirement's current known conflicts) and
// after Check Conflicts (to refresh the penalty for affected requirements).
// analystSeverity is only passed by analyseRequirements, which has just
// made the LLM call this function otherwise has no access to.
export function computeQualityScore(
  text: string,
  conflictCount = 0,
  analystSeverity?: AnalystSeverity,
): QualityScore {
  const deductions: QualityScoreDeduction[] = []
  for (const rule of RULES) {
    if (rule.test(text)) {
      deductions.push({ rule: rule.name, description: rule.description, amount: rule.amount })
    }
  }

  const textDeduction = deductions.reduce((sum, d) => sum + d.amount, 0)
  const conflictPenalty = conflictCount * 1
  const analystPenalty = analystSeverity ? SEVERITY_PENALTY[analystSeverity] : undefined
  const rawScore = SCORE_CEILING - textDeduction - conflictPenalty - (analystPenalty ?? 0)
  const score = Math.max(SCORE_FLOOR, roundToHalf(rawScore))

  return {
    score,
    deductions,
    conflictPenalty,
    ...(analystSeverity ? { analystSeverity, analystPenalty } : {}),
  }
}

// Parses the mandatory "SEVERITY: <good|fair|poor>" trailer required by
// ANALYSIS_SYSTEM_PROMPT and strips it from the prose shown to the user as
// the analystNote. Defaults to 'fair' (a visible but non-catastrophic
// penalty) if the LLM reply omits or malforms the line, rather than
// silently applying no penalty — an LLM that ignores the format
// instruction is not grounds for assuming "good".
const SEVERITY_LINE = /\n?SEVERITY:\s*(good|fair|poor)\s*$/i

export function parseAnalystSeverity(reply: string): {
  note: string
  severity: AnalystSeverity
} {
  const match = reply.match(SEVERITY_LINE)
  if (!match) {
    return { note: reply.trim(), severity: 'fair' }
  }
  return {
    note: reply.slice(0, match.index).trim(),
    severity: match[1].toLowerCase() as AnalystSeverity,
  }
}

// Splits a batched analysis reply (ANALYSIS_SYSTEM_PROMPT's "REQ-NNN:"
// block format) into one { requirementId, note, severity } per block, each
// run back through parseAnalystSeverity for its trailing SEVERITY line —
// same per-block parsing as the single-requirement path, just applied once
// per matched block instead of once per LLM call.
const ANALYSIS_BLOCK_HEADER = /^(REQ-\d+):\s*\n?/gm

export function parseAnalysisBlocks(reply: string): Array<{
  requirementId: string
  note: string
  severity: AnalystSeverity
}> {
  const headers = Array.from(reply.matchAll(ANALYSIS_BLOCK_HEADER))
  const results: Array<{ requirementId: string; note: string; severity: AnalystSeverity }> = []

  for (let i = 0; i < headers.length; i++) {
    const header = headers[i]
    const blockStart = header.index! + header[0].length
    const blockEnd = i + 1 < headers.length ? headers[i + 1].index! : reply.length
    const blockText = reply.slice(blockStart, blockEnd)
    const { note, severity } = parseAnalystSeverity(blockText)
    results.push({ requirementId: header[1], note, severity })
  }

  return results
}
