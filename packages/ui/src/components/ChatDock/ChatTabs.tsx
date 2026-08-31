import type { ChatSession } from '../../api/types'

// The tab strip along the top of the chat dock. One tab per non-archived
// ChatSession, plus a "+" that opens a fresh one. Closing a tab
// soft-archives it (the transcript is kept server-side, just hidden here).
export function ChatTabs({
  sessions,
  activeSessionId,
  onSelect,
  onNew,
  onClose,
  busy,
}: {
  sessions: ChatSession[]
  activeSessionId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onClose: (id: string) => void
  busy: boolean
}) {
  return (
    <div className="chat-dock-tabs" role="tablist">
      {sessions.map((s) => (
        <div
          key={s.id}
          className={`chat-dock-tab ${s.id === activeSessionId ? 'chat-dock-tab-active' : ''}`}
          role="tab"
          aria-selected={s.id === activeSessionId}
        >
          <button type="button" className="chat-dock-tab-label" onClick={() => onSelect(s.id)} title={s.title}>
            {s.title}
          </button>
          <button
            type="button"
            className="chat-dock-tab-close"
            aria-label={`Close ${s.title}`}
            title="Close this chat"
            disabled={busy}
            onClick={() => onClose(s.id)}
          >
            ×
          </button>
        </div>
      ))}
      <button type="button" className="chat-dock-tab-new" onClick={onNew} disabled={busy} title="New chat">
        +
      </button>
    </div>
  )
}
