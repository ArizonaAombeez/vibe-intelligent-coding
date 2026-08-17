import type { ReactNode } from 'react'

const REQ_ID_PATTERN = /REQ-\d+/g

// Splits text on REQ-NNN tokens, wrapping each in a highlighted span, so
// any requirement id mentioned in Analyst output (chat replies or
// per-requirement analysis notes) is visually distinct inline.
export function highlightRequirementIds(text: string): ReactNode[] {
  const parts: ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  REQ_ID_PATTERN.lastIndex = 0
  while ((match = REQ_ID_PATTERN.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index))
    }
    parts.push(
      <span key={match.index} className="req-id-highlight">
        {match[0]}
      </span>,
    )
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }
  return parts
}
