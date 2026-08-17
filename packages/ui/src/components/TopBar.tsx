import { useEffect, useRef, useState } from 'react'
import type { PhaseInfo, PhaseId } from '../api/types'
import './TopBar.css'

interface TopBarProps {
  phases: PhaseInfo[]
  activePhase: PhaseId
  onSelectPhase: (id: PhaseId) => void
  onReturnToProjectList: () => void
  onOpenSettings: () => void
  onOpenImportExport: () => void
  onOpenHelp: () => void
  phaseTabsDisabled: boolean
}

export function TopBar({
  phases,
  activePhase,
  onSelectPhase,
  onReturnToProjectList,
  onOpenSettings,
  onOpenImportExport,
  onOpenHelp,
  phaseTabsDisabled,
}: TopBarProps) {
  const [fileMenuOpen, setFileMenuOpen] = useState(false)
  const fileMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!fileMenuOpen) return

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setFileMenuOpen(false)
    }
    function onPointerDown(event: PointerEvent) {
      if (!fileMenuRef.current?.contains(event.target as Node)) setFileMenuOpen(false)
    }

    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [fileMenuOpen])

  return (
    <div className="top-bar">
      <div className="file-menu" ref={fileMenuRef}>
        <button
          type="button"
          className="file-menu-button"
          onClick={() => setFileMenuOpen((open) => !open)}
          aria-haspopup="menu"
          aria-expanded={fileMenuOpen}
        >
          File
        </button>
        {fileMenuOpen && (
          <div className="file-menu-dropdown" role="menu">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setFileMenuOpen(false)
                onReturnToProjectList()
              }}
            >
              Open Project
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setFileMenuOpen(false)
                onReturnToProjectList()
              }}
            >
              Close Project
            </button>
            <div className="file-menu-separator" />
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setFileMenuOpen(false)
                onOpenImportExport()
              }}
            >
              Import / Export...
            </button>
            <div className="file-menu-separator" />
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setFileMenuOpen(false)
                onOpenSettings()
              }}
            >
              Settings
            </button>
          </div>
        )}
      </div>

      <nav className="phase-tabs" aria-label="Phases">
        {phases.map((phase, index) => {
          const disabled = phaseTabsDisabled && phase.id !== 'dashboard' && phase.status === 'not-started'
          return (
            <button
              key={phase.id}
              type="button"
              className={`phase-tab ${activePhase === phase.id ? 'active' : ''}`}
              onClick={() => onSelectPhase(phase.id)}
              disabled={disabled}
              title={disabled ? 'Complete the prior phase to unlock' : undefined}
            >
              <span className="phase-tab-number">{index + 1}</span>
              {phase.label}
            </button>
          )
        })}
      </nav>

      <button type="button" className="help-button" onClick={onOpenHelp} aria-label="Help">
        ?
      </button>
    </div>
  )
}
