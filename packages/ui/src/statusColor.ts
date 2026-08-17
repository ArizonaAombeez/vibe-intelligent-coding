import type { RequirementStatus, Status } from './api/types'

// Single 4-state colour scale used everywhere status applies
// (phase tabs, sidebar substeps, requirement/story/test rows, architecture overlay).
export const STATUS_COLOR: Record<Status, string> = {
  'not-started': 'var(--status-grey)',
  'in-progress': 'var(--status-amber)',
  blocked: 'var(--status-red)',
  complete: 'var(--status-green)',
}

export const STATUS_LABEL: Record<Status, string> = {
  'not-started': 'Not started',
  'in-progress': 'In progress',
  blocked: 'Blocked',
  complete: 'Complete',
}

// Human-readable label for a requirement's own lifecycle status (distinct
// from the 4-state Status scale above) — every raw RequirementStatus display
// spot (RequirementDetailPanel, ArchitectureRequirementList) goes through
// this instead of printing the enum value verbatim, per Mark's requirement
// that a coded element/requirement shows 'coded' and a tested group shows
// 'tested - passed' or 'tested - fail' rather than a bare 'tested'.
export const REQUIREMENT_STATUS_LABEL: Record<RequirementStatus, string> = {
  elicited: 'Elicited',
  architected: 'Architected',
  allocated: 'Allocated',
  coded: 'Coded',
  tested: 'Tested - Passed',
  'tested-fail': 'Tested - Fail',
  complete: 'Complete',
}

// Deterministic 1-5 requirement quality score colour scale — distinct
// concept from Status above (lifecycle stage vs. text-quality signal),
// so it's a separate lookup rather than folded into STATUS_COLOR.
export function QUALITY_SCORE_COLOR(score: number): string {
  if (score >= 4) return 'var(--status-green)'
  if (score >= 3) return 'var(--status-amber)'
  return 'var(--status-red)'
}
