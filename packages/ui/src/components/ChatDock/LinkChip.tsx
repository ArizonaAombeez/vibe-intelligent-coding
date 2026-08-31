import type { ChatMessageLink } from '../../api/types'
import type { ChatLinkNavHandler } from '../../navigation/chatLinkNav'

const KIND_LABEL: Record<ChatMessageLink['kind'], string> = {
  requirement: 'Requirement',
  element: 'Element',
  testCase: 'Test',
}

// A clickable reference inside an assistant chat message. Styled like the
// inline REQ-NNN highlight spans (requirementIdHighlight.tsx) but a real
// button, so it reads as navigable. The label is denormalised on the link
// itself so it stays meaningful even if the target was since renamed or
// deleted; the nav handler decides what happens on click (and can no-op +
// toast if the target no longer exists).
export function LinkChip({ link, onNavigate }: { link: ChatMessageLink; onNavigate: ChatLinkNavHandler }) {
  return (
    <button
      type="button"
      className={`chat-link-chip chat-link-chip-${link.kind}`}
      title={`${KIND_LABEL[link.kind]}: ${link.label}`}
      onClick={() => onNavigate(link)}
    >
      <span className="chat-link-chip-kind">{KIND_LABEL[link.kind]}</span>
      <span className="chat-link-chip-label">{link.label}</span>
    </button>
  )
}
