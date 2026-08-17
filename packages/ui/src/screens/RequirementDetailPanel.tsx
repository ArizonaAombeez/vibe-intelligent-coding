import { useEffect, useState } from 'react'
import type { ApplySplitRequirementResult, Architecture, Requirement, VicCoreApi } from '../api/types'
import { QUALITY_SCORE_COLOR, REQUIREMENT_STATUS_LABEL } from '../statusColor'
import { highlightRequirementIds } from './requirementIdHighlight'
import { SplitRequirementDialog } from './SplitRequirementDialog'
import './RequirementDetailPanel.css'

interface RequirementDetailPanelProps {
  api: VicCoreApi
  projectId: string
  requirement: Requirement
  architecture: Architecture | null
  onSave: (text: string) => Promise<void>
  widthPercent: number
  onResizeStart: (e: React.MouseEvent) => void
  hasResults: boolean
  onShowResults: () => void
  onSplitApplied: (result: ApplySplitRequirementResult) => void
  onAddElement: (architectureElementId: string) => Promise<void>
  onRemoveElement: (architectureElementId: string) => Promise<void>
}

export function RequirementDetailPanel({
  api,
  projectId,
  requirement,
  architecture,
  onSave,
  widthPercent,
  onResizeStart,
  hasResults,
  onShowResults,
  onSplitApplied,
  onAddElement,
  onRemoveElement,
}: RequirementDetailPanelProps) {
  const [editing, setEditing] = useState(false)
  const [draftText, setDraftText] = useState(requirement.text)
  const [saving, setSaving] = useState(false)
  const [splitDialogOpen, setSplitDialogOpen] = useState(false)
  const [allocating, setAllocating] = useState(false)
  const [addElementValue, setAddElementValue] = useState('')

  useEffect(() => {
    setDraftText(requirement.text)
    setEditing(false)
  }, [requirement.id, requirement.text])

  async function handleSave() {
    if (!draftText.trim()) return
    setSaving(true)
    try {
      await onSave(draftText.trim())
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  async function handleAddElement(elementId: string) {
    if (!elementId) return
    setAllocating(true)
    try {
      await onAddElement(elementId)
      setAddElementValue('')
    } finally {
      setAllocating(false)
    }
  }

  async function handleRemoveElement(elementId: string) {
    setAllocating(true)
    try {
      await onRemoveElement(elementId)
    } finally {
      setAllocating(false)
    }
  }

  return (
    <div className="requirement-detail-panel" style={{ flexBasis: `${widthPercent}%` }}>
      <div className="requirement-detail-resize-handle" onMouseDown={onResizeStart} />
      <div className="requirement-detail-panel-content">
        <div className="requirement-detail-header">
          <span className="requirement-detail-id">{requirement.id}</span>
          {hasResults && (
            <button type="button" className="requirement-detail-edit-btn" onClick={onShowResults}>
              View results
            </button>
          )}
        </div>

        <section className="requirement-detail-section">
          <div className="requirement-detail-section-header">
            <h3>Text</h3>
            {!editing && (
              <div className="requirement-detail-text-actions">
                <button type="button" className="requirement-detail-edit-btn" onClick={() => setEditing(true)}>
                  Edit
                </button>
                <button type="button" className="requirement-detail-edit-btn" onClick={() => setSplitDialogOpen(true)}>
                  Split
                </button>
              </div>
            )}
          </div>
          {editing ? (
            <>
              <textarea
                className="requirement-detail-edit-textarea"
                value={draftText}
                onChange={(e) => setDraftText(e.target.value)}
                rows={4}
              />
              <div className="requirement-detail-edit-actions">
                <button type="button" onClick={handleSave} disabled={saving || !draftText.trim()}>
                  Save
                </button>
                <button
                  type="button"
                  className="requirement-detail-cancel-btn"
                  onClick={() => {
                    setDraftText(requirement.text)
                    setEditing(false)
                  }}
                  disabled={saving}
                >
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <p className="requirement-detail-text">{requirement.text}</p>
          )}
        </section>

        <section className="requirement-detail-section">
          <h3>Status</h3>
          <dl className="requirement-detail-fields">
            <dt>Status</dt>
            <dd>{REQUIREMENT_STATUS_LABEL[requirement.status]}</dd>
            <dt>Created</dt>
            <dd>{new Date(requirement.createdAt).toLocaleString()}</dd>
          </dl>
        </section>

        {requirement.qualityScore && (
          <section className="requirement-detail-section">
            <h3>Quality score</h3>
            <div className="quality-score-summary">
              <span
                className="quality-score-badge quality-score-badge-large"
                style={{ background: QUALITY_SCORE_COLOR(requirement.qualityScore.score) }}
              >
                {requirement.qualityScore.score}
              </span>
              <span className="quality-score-out-of">/ 5</span>
            </div>
            <p className="requirement-detail-note quality-score-disclaimer">
              Automated heuristic checks (INCOSE Guide for Writing Requirements-derived),
              not a substitute for human review.
            </p>
            {requirement.qualityScore.deductions.length === 0 &&
              requirement.qualityScore.conflictPenalty === 0 &&
              !requirement.qualityScore.analystPenalty && (
                <p className="requirement-detail-note">No issues found.</p>
              )}
            {requirement.qualityScore.deductions.length > 0 && (
              <ul className="quality-score-deductions">
                {requirement.qualityScore.deductions.map((d, i) => (
                  <li key={i}>
                    <strong>{d.rule}</strong> (−{d.amount}) — {d.description}
                  </li>
                ))}
              </ul>
            )}
            {requirement.qualityScore.conflictPenalty > 0 && (
              <p className="requirement-detail-note">
                Conflict penalty: −{requirement.qualityScore.conflictPenalty} (
                {requirement.conflicts?.length ?? 0} unresolved conflict
                {(requirement.conflicts?.length ?? 0) === 1 ? '' : 's'})
              </p>
            )}
            {!!requirement.qualityScore.analystPenalty && (
              <p className="requirement-detail-note">
                Analyst severity: <strong>{requirement.qualityScore.analystSeverity}</strong> (−
                {requirement.qualityScore.analystPenalty}) — see Analyst notes below.
              </p>
            )}
          </section>
        )}

        <section className="requirement-detail-section">
          <h3>Analyst notes</h3>
          <p className="requirement-detail-note">
            {requirement.analystNote
              ? highlightRequirementIds(requirement.analystNote)
              : 'Not Run Yet'}
          </p>
        </section>

        <section className="requirement-detail-section">
          <h3>Conflict Detail</h3>
          {!requirement.conflictsCheckedAt && <p className="requirement-detail-note">Not Run Yet</p>}
          {requirement.conflictsCheckedAt && (!requirement.conflicts || requirement.conflicts.length === 0) && (
            <p className="requirement-detail-note">None found</p>
          )}
          {requirement.conflictsCheckedAt && requirement.conflicts && requirement.conflicts.length > 0 && (
            <ul className="quality-score-deductions">
              {requirement.conflicts.map((conflict) => (
                <li key={conflict.requirementId}>
                  <strong>{conflict.requirementId}</strong> — {highlightRequirementIds(conflict.rationale)}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="requirement-detail-section">
          <h3>Traceability</h3>
          <div className="requirement-detail-allocation">
            <span>Architecture elements</span>
            {requirement.architectureElements.length > 0 ? (
              <ul className="requirement-detail-allocation-chips">
                {requirement.architectureElements.map((elementId) => {
                  const element = architecture?.elements.find((el) => el.id === elementId)
                  return (
                    <li key={elementId} className="requirement-detail-allocation-chip">
                      <span>{element ? element.name : elementId}</span>
                      <button
                        type="button"
                        className="requirement-detail-allocation-chip-remove"
                        onClick={() => handleRemoveElement(elementId)}
                        disabled={allocating}
                        aria-label={`Remove allocation to ${element ? element.name : elementId}`}
                      >
                        ×
                      </button>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p className="requirement-detail-note">Unallocated.</p>
            )}
            {architecture && architecture.elements.length > 0 ? (
              <select
                id="requirement-detail-allocation-select"
                className="requirement-detail-allocation-select"
                value={addElementValue}
                onChange={(e) => handleAddElement(e.target.value)}
                disabled={allocating}
              >
                <option value="">Add element...</option>
                {architecture.elements
                  .filter((el) => !requirement.architectureElements.includes(el.id))
                  .map((el) => (
                    <option key={el.id} value={el.id}>
                      {el.name}
                    </option>
                  ))}
              </select>
            ) : (
              <p className="requirement-detail-note">
                No architecture elements yet — add some on the Architecture tab first.
              </p>
            )}
          </div>
          <dl className="requirement-detail-fields requirement-detail-fields-placeholder">
            <dt>Coding</dt>
            <dd>Not started — stage not yet built</dd>
            <dt>Test</dt>
            <dd>Not started — stage not yet built</dd>
          </dl>
        </section>
      </div>

      {splitDialogOpen && (
        <SplitRequirementDialog
          api={api}
          projectId={projectId}
          requirement={requirement}
          architecture={architecture}
          onClose={() => setSplitDialogOpen(false)}
          onApplied={(result) => {
            setSplitDialogOpen(false)
            onSplitApplied(result)
          }}
        />
      )}
    </div>
  )
}

