import { useState } from 'react'
import type { ProposedStory } from '../api/types'

interface EditableStoryProposalCardProps {
  proposal: ProposedStory
  elementNames: string[]
  onAccept: (proposal: ProposedStory) => void
  onDiscard: (proposal: ProposedStory) => void
}

// Same edit-before-accept pattern as EditableProposalCard/
// EditableElementProposalCard, but for the Planning chat's structured story
// proposals (target architecture element/title/description).
export function EditableStoryProposalCard({
  proposal,
  elementNames,
  onAccept,
  onDiscard,
}: EditableStoryProposalCardProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(proposal)

  if (editing) {
    return (
      <div className="analyst-chat-proposal">
        <label className="architecture-detail-field-label">Architecture element</label>
        <select
          className="architecture-detail-input"
          value={draft.architectureElementName}
          onChange={(e) => setDraft({ ...draft, architectureElementName: e.target.value })}
        >
          {elementNames.length === 0 || !elementNames.includes(draft.architectureElementName) ? (
            <option value={draft.architectureElementName}>{draft.architectureElementName}</option>
          ) : null}
          {elementNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>

        <label className="architecture-detail-field-label">Title</label>
        <input
          className="architecture-detail-input"
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          autoFocus
        />

        <label className="architecture-detail-field-label">Description</label>
        <textarea
          className="requirement-detail-edit-textarea"
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          rows={2}
        />

        <div className="requirement-detail-edit-actions">
          <button type="button" onClick={() => onAccept(draft)} disabled={!draft.title.trim()}>
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
        <strong>{proposal.title}</strong> ({proposal.architectureElementName}) — {proposal.description}
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
