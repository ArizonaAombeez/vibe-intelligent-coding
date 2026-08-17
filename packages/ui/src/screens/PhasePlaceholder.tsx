import type { PhaseInfo } from '../api/types'
import './PhasePlaceholder.css'

interface PhasePlaceholderProps {
  phase: PhaseInfo
  activeSubstep: string | null
}

export function PhasePlaceholder({ phase, activeSubstep }: PhasePlaceholderProps) {
  const substepLabel = phase.substeps.find((s) => s.id === activeSubstep)?.label

  return (
    <div className="phase-placeholder">
      <h1>{phase.label}</h1>
      {substepLabel && <p className="phase-placeholder-substep">{substepLabel}</p>}
      <p className="phase-placeholder-note">
        This phase's screen is not yet implemented. It will render real content once
        its underlying data model and core API are wired in.
      </p>
    </div>
  )
}
