import type { ChatMessageLink } from '../api/types'

// Where a chat link chip sends the user. Screens don't own cross-screen
// navigation, so a chip click is a two-part message: switch the phase tab,
// and hand the target screen a pending selection it applies to its own
// local selection state on mount/update. App wires this up (see
// pendingChatNav in App.tsx).

export type ChatNavPhase = 'requirements' | 'architecture' | 'test-creation' | 'test-execution'

export interface PendingChatNav {
  phase: ChatNavPhase
  kind: ChatMessageLink['kind']
  id: string
}

// A chip's kind maps 1:1 to a destination screen. testCase links prefer the
// Test Execution screen (that's where a failing run and its triage live);
// the Test Creation screen also selects by test id if the user is already
// there, but navigation always lands on Test Execution.
export function pendingNavForLink(link: ChatMessageLink): PendingChatNav {
  switch (link.kind) {
    case 'requirement':
      return { phase: 'requirements', kind: 'requirement', id: link.id }
    case 'element':
      return { phase: 'architecture', kind: 'element', id: link.id }
    case 'testCase':
      return { phase: 'test-execution', kind: 'testCase', id: link.id }
  }
}

export type ChatLinkNavHandler = (link: ChatMessageLink) => void
