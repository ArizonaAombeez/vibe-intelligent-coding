import { useState } from 'react'
import type { InterfaceContractOperation } from '../api/types'
import '../components/ModalOverlay.css'
import './RequirementDetailPanel.css'
import './InterfaceEditorModal.css'

interface InterfaceEditorModalProps {
  // One label per participant, already resolved by the caller (e.g.
  // "Sensor Bus (produces)") — length >= 2. Replaces the old fixed
  // fromLabel/toLabel pair so this same modal covers an N-ary shared
  // interface (a bus with 3+ participants), not just a 2-element pair.
  participantLabels: string[]
  operations: InterfaceContractOperation[]
  onSave: (operations: InterfaceContractOperation[]) => Promise<void>
  onClose: () => void
}

function emptyOperation(): InterfaceContractOperation {
  return { name: '', description: '', request: '', response: '', errors: '' }
}

// Manual editor for one interface definition's operations — the "list and
// edit all interfaces" requirement's actual editing surface. No LLM call:
// the user directly authors/edits each operation's shape and its
// range/resolution/unit/update-frequency (or driven-directly) data-contract
// detail. Used both from the global Interfaces list and from an element's
// own focus view, so it only needs the resolved participant labels and the
// current operations — the caller owns which definition this is.
export function InterfaceEditorModal({ participantLabels, operations, onSave, onClose }: InterfaceEditorModalProps) {
  const [draft, setDraft] = useState<InterfaceContractOperation[]>(
    operations.length > 0 ? operations.map((op) => ({ ...op })) : [emptyOperation()],
  )
  const [saving, setSaving] = useState(false)

  function updateOp(index: number, fields: Partial<InterfaceContractOperation>) {
    setDraft((prev) => prev.map((op, i) => (i === index ? { ...op, ...fields } : op)))
  }

  function addOp() {
    setDraft((prev) => [...prev, emptyOperation()])
  }

  function removeOp(index: number) {
    setDraft((prev) => prev.filter((_, i) => i !== index))
  }

  async function handleSave() {
    setSaving(true)
    try {
      // An operation with no name at all is treated as a blank row the user
      // never filled in, not a real operation — dropped rather than saved
      // as an empty entry.
      const cleaned = draft.filter((op) => op.name.trim().length > 0)
      await onSave(cleaned)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel interface-editor-modal" onClick={(e) => e.stopPropagation()}>
        <div className="requirement-detail-header">
          <span className="requirement-detail-id">
            {participantLabels.join(' ↔ ')}
          </span>
          <button type="button" className="requirement-detail-edit-btn" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="interface-editor-operation-list">
          {draft.map((op, index) => (
            <div key={index} className="interface-editor-operation">
              <div className="interface-editor-operation-header">
                <input
                  className="architecture-detail-input"
                  value={op.name}
                  onChange={(e) => updateOp(index, { name: e.target.value })}
                  placeholder="Operation name"
                />
                <button type="button" className="requirement-detail-edit-btn" onClick={() => removeOp(index)}>
                  Remove
                </button>
              </div>

              <label className="architecture-detail-field-label">Description</label>
              <input
                className="architecture-detail-input"
                value={op.description}
                onChange={(e) => updateOp(index, { description: e.target.value })}
                placeholder="What this operation does"
              />

              <div className="interface-editor-field-row">
                <div>
                  <label className="architecture-detail-field-label">Request</label>
                  <input
                    className="architecture-detail-input"
                    value={op.request}
                    onChange={(e) => updateOp(index, { request: e.target.value })}
                    placeholder="e.g. userId: string"
                  />
                </div>
                <div>
                  <label className="architecture-detail-field-label">Response</label>
                  <input
                    className="architecture-detail-input"
                    value={op.response}
                    onChange={(e) => updateOp(index, { response: e.target.value })}
                    placeholder="e.g. sessionToken: string"
                  />
                </div>
              </div>

              <label className="architecture-detail-field-label">Error cases</label>
              <input
                className="architecture-detail-input"
                value={op.errors}
                onChange={(e) => updateOp(index, { errors: e.target.value })}
                placeholder="e.g. InvalidCredentials, or leave blank"
              />

              <div className="interface-editor-field-row">
                <div>
                  <label className="architecture-detail-field-label">Range</label>
                  <input
                    className="architecture-detail-input"
                    value={op.range ?? ''}
                    onChange={(e) => updateOp(index, { range: e.target.value || undefined })}
                    placeholder="e.g. 0-100, or N/A"
                  />
                </div>
                <div>
                  <label className="architecture-detail-field-label">Resolution</label>
                  <input
                    className="architecture-detail-input"
                    value={op.resolution ?? ''}
                    onChange={(e) => updateOp(index, { resolution: e.target.value || undefined })}
                    placeholder="e.g. 1, 0.01, or N/A"
                  />
                </div>
                <div>
                  <label className="architecture-detail-field-label">Unit</label>
                  <input
                    className="architecture-detail-input"
                    value={op.unit ?? ''}
                    onChange={(e) => updateOp(index, { unit: e.target.value || undefined })}
                    placeholder="e.g. ms, %, or N/A"
                  />
                </div>
              </div>

              <label className="architecture-detail-field-label">Update frequency</label>
              <div className="interface-editor-frequency-row">
                <input
                  className="architecture-detail-input"
                  value={op.drivenDirectly ? '' : (op.updateFrequency ?? '')}
                  onChange={(e) => updateOp(index, { updateFrequency: e.target.value || undefined, drivenDirectly: undefined })}
                  placeholder="e.g. every 100ms, on user action"
                  disabled={op.drivenDirectly === true}
                />
                <label className="architecture-detail-interface-option">
                  <input
                    type="checkbox"
                    checked={op.drivenDirectly === true}
                    onChange={(e) =>
                      updateOp(index, {
                        drivenDirectly: e.target.checked ? true : undefined,
                        updateFrequency: e.target.checked ? undefined : op.updateFrequency,
                      })
                    }
                  />
                  Driven directly (not periodic)
                </label>
              </div>
            </div>
          ))}
        </div>

        <button type="button" className="requirement-detail-edit-btn" onClick={addOp}>
          + Add operation
        </button>

        <div className="requirement-detail-edit-actions">
          <button type="button" onClick={handleSave} disabled={saving}>
            Save
          </button>
          <button type="button" className="requirement-detail-cancel-btn" onClick={onClose} disabled={saving}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
