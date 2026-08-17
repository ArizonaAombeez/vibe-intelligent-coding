import { useState } from 'react'
import { EXTERNAL_CONTEXT_ROW, type ArchitectureElementKind, type CreateArchitectureElementFields } from '../api/types'
import '../components/ModalOverlay.css'
import './RequirementDetailPanel.css'

interface AddArchitectureElementFormProps {
  layers: string[]
  onAdd: (fields: CreateArchitectureElementFields) => Promise<void>
  onClose: () => void
}

const KIND_OPTIONS: { value: ArchitectureElementKind; label: string }[] = [
  { value: 'functional', label: 'Functional block' },
  { value: 'interface-spine', label: 'Interface spine' },
  { value: 'service', label: 'Service' },
  { value: 'external', label: 'External / environment' },
  { value: 'runtime', label: 'Runtime / execution' },
]

export function AddArchitectureElementForm({ layers, onAdd, onClose }: AddArchitectureElementFormProps) {
  const [kind, setKind] = useState<ArchitectureElementKind>('functional')
  const [name, setName] = useState('')
  const [responsibility, setResponsibility] = useState('')
  const [row, setRow] = useState(0)
  const [col, setCol] = useState(0)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setSubmitting(true)
    try {
      // External elements always live in the reserved context band, outside
      // the main layer grid, regardless of whatever row was last selected.
      const effectiveRow = kind === 'external' ? EXTERNAL_CONTEXT_ROW : row
      await onAdd({ kind, name: name.trim(), responsibility: responsibility.trim(), row: effectiveRow, col })
      onClose()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="requirement-detail-header">
          <span className="requirement-detail-id">Add element</span>
          <button type="button" className="requirement-detail-edit-btn" onClick={onClose}>
            Close
          </button>
        </div>
        <form onSubmit={handleSubmit} className="architecture-add-form">
          <label className="architecture-detail-field-label">Kind</label>
          <select
            className="architecture-detail-input"
            value={kind}
            onChange={(e) => setKind(e.target.value as ArchitectureElementKind)}
          >
            {KIND_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>

          <label className="architecture-detail-field-label">Name</label>
          <input
            className="architecture-detail-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Login Service"
            autoFocus
          />

          <label className="architecture-detail-field-label">Responsibility</label>
          <textarea
            className="requirement-detail-edit-textarea"
            value={responsibility}
            onChange={(e) => setResponsibility(e.target.value)}
            rows={2}
            placeholder="One-line responsibility statement"
          />

          {kind === 'external' ? (
            <p className="requirement-detail-note">
              External elements are placed in the "External Context" band, outside the main layer grid.
            </p>
          ) : (
            <>
              <label className="architecture-detail-field-label">Layer row</label>
              <select
                className="architecture-detail-input"
                value={row}
                onChange={(e) => setRow(Number(e.target.value))}
              >
                {layers.length === 0 ? (
                  <option value={0}>Row 1</option>
                ) : (
                  layers.map((label, i) => (
                    <option key={i} value={i}>
                      {label}
                    </option>
                  ))
                )}
              </select>
            </>
          )}

          <label className="architecture-detail-field-label">Column</label>
          <input
            type="number"
            min={0}
            className="architecture-detail-input"
            value={col}
            onChange={(e) => setCol(Math.max(0, Number(e.target.value)))}
          />

          <div className="requirement-detail-edit-actions">
            <button type="submit" disabled={submitting || !name.trim()}>
              Add
            </button>
            <button type="button" className="requirement-detail-cancel-btn" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
