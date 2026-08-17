import { useState } from 'react'
import type { ArchitectureElementKind, ProposedArchitectureElement } from '../api/types'

interface EditableElementProposalCardProps {
  proposal: ProposedArchitectureElement
  layers: string[]
  onAccept: (proposal: ProposedArchitectureElement) => void
  onDiscard: (proposal: ProposedArchitectureElement) => void
}

const KIND_OPTIONS: { value: ArchitectureElementKind; label: string }[] = [
  { value: 'functional', label: 'Functional block' },
  { value: 'interface-spine', label: 'Interface spine' },
  { value: 'service', label: 'Service' },
  { value: 'external', label: 'External / environment' },
  { value: 'runtime', label: 'Runtime / execution' },
]

// Same edit-before-accept pattern as EditableProposalCard, but for the
// architecture chat's structured element proposals (name/kind/layer/
// responsibility) rather than a single text string.
export function EditableElementProposalCard({
  proposal,
  layers,
  onAccept,
  onDiscard,
}: EditableElementProposalCardProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(proposal)

  if (editing) {
    return (
      <div className="analyst-chat-proposal">
        <label className="architecture-detail-field-label">Kind</label>
        <select
          className="architecture-detail-input"
          value={draft.kind}
          onChange={(e) => setDraft({ ...draft, kind: e.target.value as ArchitectureElementKind })}
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
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          autoFocus
        />

        <label className="architecture-detail-field-label">Responsibility</label>
        <textarea
          className="requirement-detail-edit-textarea"
          value={draft.responsibility}
          onChange={(e) => setDraft({ ...draft, responsibility: e.target.value })}
          rows={2}
        />

        {draft.kind !== 'external' && (
          <>
            <label className="architecture-detail-field-label">Layer</label>
            <select
              className="architecture-detail-input"
              value={draft.layer}
              onChange={(e) => setDraft({ ...draft, layer: e.target.value })}
            >
              {layers.length === 0 || !layers.includes(draft.layer) ? (
                <option value={draft.layer}>{draft.layer || 'NONE'}</option>
              ) : null}
              {layers.map((label) => (
                <option key={label} value={label}>
                  {label}
                </option>
              ))}
            </select>
          </>
        )}

        <div className="requirement-detail-edit-actions">
          <button type="button" onClick={() => onAccept(draft)} disabled={!draft.name.trim()}>
            Accept
          </button>
          <button
            type="button"
            className="requirement-detail-cancel-btn"
            onClick={() => {
              setDraft(proposal)
              setEditing(false)
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="analyst-chat-proposal">
      <p>
        <strong>{proposal.name}</strong> ({proposal.kind}
        {proposal.layer !== 'NONE' ? `, ${proposal.layer}` : ''}) — {proposal.responsibility}
      </p>
      <div className="analyst-chat-proposal-actions">
        <button type="button" onClick={() => onAccept(proposal)}>
          Accept
        </button>
        <button type="button" className="requirement-detail-edit-btn" onClick={() => setEditing(true)}>
          Edit
        </button>
        <button type="button" onClick={() => onDiscard(proposal)}>
          Discard
        </button>
      </div>
    </div>
  )
}
