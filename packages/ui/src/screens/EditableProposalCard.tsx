import { useState } from 'react'

interface EditableProposalCardProps {
  text: string
  onAccept: (text: string) => void
  onDiscard: (text: string) => void
}

// Shared accept/edit/discard card for plain-text proposals (analyst/architect
// chat suggestions, gap-check suggestions, code-gap-scan suggestions) — lets
// the human correct wording before it becomes a real requirement instead of
// only being able to take-it-or-leave-it.
export function EditableProposalCard({ text, onAccept, onDiscard }: EditableProposalCardProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(text)

  if (editing) {
    return (
      <div className="analyst-chat-proposal">
        <textarea
          className="requirement-detail-edit-textarea"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={3}
          autoFocus
        />
        <div className="requirement-detail-edit-actions">
          <button type="button" onClick={() => onAccept(draft.trim())} disabled={!draft.trim()}>
            Accept
          </button>
          <button
            type="button"
            className="requirement-detail-cancel-btn"
            onClick={() => {
              setDraft(text)
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
      <p>{text}</p>
      <div className="analyst-chat-proposal-actions">
        <button type="button" onClick={() => onAccept(text)}>
          Accept
        </button>
        <button type="button" className="requirement-detail-edit-btn" onClick={() => setEditing(true)}>
          Edit
        </button>
        <button type="button" onClick={() => onDiscard(text)}>
          Discard
        </button>
      </div>
    </div>
  )
}
