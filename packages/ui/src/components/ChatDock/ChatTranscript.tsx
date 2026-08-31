import type { ReactNode } from 'react'
import type { ChatMessage } from '../../api/types'
import type { ChatLinkNavHandler } from '../../navigation/chatLinkNav'
import { LinkChip } from './LinkChip'

const DISPATCH_VERDICT_LABEL: Record<NonNullable<ChatMessage['dispatch']>['verdict'], string> = {
  'code-failure': 'Dispatched as a code failure',
  'requirement-issue': 'Dispatched as a requirement issue',
  'test-case-failure': 'Triaged as a test case failure — needs manual review',
}

// Renders one chat session's messages. `roleLabel` names the assistant
// persona for the surface ("Analyst" / "Architect" / "QA"). `renderText`
// lets a surface post-process message text (the analyst/QA surfaces run
// highlightRequirementIds over it); it defaults to plain text.
export function ChatTranscript({
  messages,
  roleLabel,
  busy,
  onNavigate,
  renderText,
  emptyHint,
}: {
  messages: ChatMessage[]
  roleLabel: string
  busy: boolean
  onNavigate: ChatLinkNavHandler
  renderText?: (text: string) => ReactNode
  emptyHint: string
}) {
  const isEmpty = messages.length === 0
  return (
    <div className={`analyst-chat-history ${isEmpty ? 'analyst-chat-history-empty' : ''}`}>
      {isEmpty && !busy && <p className="analyst-chat-empty">{emptyHint}</p>}
      {messages.map((m) => (
        <div key={m.id} className={`analyst-chat-entry analyst-chat-entry-${m.role === 'user' ? 'user' : 'analyst'}`}>
          <strong>{m.role === 'user' ? 'You' : roleLabel}</strong>
          <p>{renderText ? renderText(m.text) : m.text}</p>
          {m.dispatch && (
            <p className="chat-dock-dispatch">
              {DISPATCH_VERDICT_LABEL[m.dispatch.verdict]}
              {m.dispatch.rationale ? ` — ${m.dispatch.rationale}` : ''}
            </p>
          )}
          {m.links && m.links.length > 0 && (
            <div className="chat-dock-links">
              {m.links.map((link) => (
                <LinkChip key={`${link.kind}:${link.id}`} link={link} onNavigate={onNavigate} />
              ))}
            </div>
          )}
        </div>
      ))}
      {busy && <p className="analyst-chat-empty">{roleLabel} is thinking...</p>}
    </div>
  )
}
