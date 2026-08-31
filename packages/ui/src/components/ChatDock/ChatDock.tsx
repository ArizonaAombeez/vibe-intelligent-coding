import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { ChatMessage, ChatSessionFocus, ChatSurface, VicCoreApi } from '../../api/types'
import { toOperationError } from '../../api/errorCode'
import type { ChatLinkNavHandler } from '../../navigation/chatLinkNav'
import { useChatSessions } from './useChatSessions'
import { ChatTabs } from './ChatTabs'
import { ChatTranscript } from './ChatTranscript'
import './ChatDock.css'

const DEFAULT_CHAT_HEIGHT = 260
const MIN_CHAT_HEIGHT = 120
const MAX_CHAT_HEIGHT = 640

export interface ChatDockSendResult {
  userMessage?: ChatMessage
  assistantMessage?: ChatMessage
}

export interface ChatDockProps {
  api: VicCoreApi
  projectId: string
  surface: ChatSurface
  /** Persona name shown against assistant turns and in the "thinking" line. */
  roleLabel: string
  heading: string
  hint: string
  placeholder: string
  /** Selection context stamped onto any NEW tab opened from this dock. */
  currentFocus?: ChatSessionFocus
  onOpenSettings: () => void
  onNavigateLink: ChatLinkNavHandler
  /** Post-process message text (e.g. highlight REQ-NNN tokens). */
  renderMessageText?: (text: string) => ReactNode
  /**
   * The surface-specific send. Receives the bound session id and the raw
   * message; must POST to the surface's chat route with that sessionId and
   * return the two persisted messages from the response. Any surface-side
   * effects (appending proposal cards, refreshing a list) happen here.
   */
  sendMessage: (sessionId: string, message: string) => Promise<ChatDockSendResult>
  /** Rendered under the transcript — proposal cards, dispatch details, etc. */
  renderExtras?: () => ReactNode
  /**
   * When `nonce` changes, the dock replaces its input with `text` and
   * focuses+scrolls it into view. Lets a screen action ("ask the Architect
   * about this interface") prefill the composer.
   */
  prefill?: { text: string; nonce: number }
  /**
   * 'dock' (default) renders the full bottom-docked shell with a resize
   * handle. 'embedded' drops the outer shell + handle and renders just the
   * panel, for screens that place the chat inside their own layout column.
   */
  variant?: 'dock' | 'embedded'
}

export function ChatDock({
  api,
  projectId,
  surface,
  roleLabel,
  heading,
  hint,
  placeholder,
  currentFocus,
  onOpenSettings,
  onNavigateLink,
  renderMessageText,
  sendMessage,
  renderExtras,
  prefill,
  variant = 'dock',
}: ChatDockProps) {
  const sessionsCtl = useChatSessions(api, projectId, surface, currentFocus)
  const [chatInput, setChatInput] = useState('')
  const [chatBusy, setChatBusy] = useState(false)
  const [chatError, setChatError] = useState<string | null>(null)
  const [chatErrorIsLlmNotConfigured, setChatErrorIsLlmNotConfigured] = useState(false)
  const [chatHeight, setChatHeight] = useState(DEFAULT_CHAT_HEIGHT)
  const resizingRef = useRef(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const prefillNonce = prefill?.nonce
  useEffect(() => {
    if (prefillNonce === undefined) return
    setChatInput(prefill?.text ?? '')
    inputRef.current?.focus()
    inputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    // Intentionally keyed only on the nonce — re-prefilling with the same
    // text is still a deliberate action from the caller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillNonce])

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      resizingRef.current = true
      const startY = e.clientY
      const startHeight = chatHeight
      function onMove(moveEvent: MouseEvent) {
        if (!resizingRef.current) return
        const delta = startY - moveEvent.clientY
        setChatHeight(Math.min(MAX_CHAT_HEIGHT, Math.max(MIN_CHAT_HEIGHT, startHeight + delta)))
      }
      function onUp() {
        resizingRef.current = false
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [chatHeight],
  )

  const doSend = useCallback(async () => {
    const message = chatInput.trim()
    if (!message || chatBusy) return
    setChatInput('')
    setChatBusy(true)
    setChatError(null)
    setChatErrorIsLlmNotConfigured(false)
    try {
      await sessionsCtl.sendTurn(message, (sessionId) => sendMessage(sessionId, message))
    } catch (err) {
      const operationError = toOperationError(err)
      setChatError(operationError.error ?? 'Something went wrong')
      setChatErrorIsLlmNotConfigured(operationError.errorCode === 'llm-not-configured')
      // Put the message back so the user doesn't lose it.
      setChatInput(message)
    } finally {
      setChatBusy(false)
    }
  }, [chatInput, chatBusy, sessionsCtl, sendMessage])

  const activeMessages = sessionsCtl.activeSession?.messages ?? []

  const panel = (
    <div className="analyst-chat-panel">
      <div className="analyst-chat-heading-row">
          <h2>{heading}</h2>
          <span className="analyst-chat-hint">{hint}</span>
        </div>

        <ChatTabs
          sessions={sessionsCtl.sessions}
          activeSessionId={sessionsCtl.activeSessionId}
          onSelect={sessionsCtl.selectSession}
          onNew={() => void sessionsCtl.newSession()}
          onClose={(id) => void sessionsCtl.closeSession(id)}
          busy={chatBusy || sessionsCtl.loading}
        />

        {sessionsCtl.loadError && (
          <div className="analyst-chat-error">
            <span>{sessionsCtl.loadError}</span>
          </div>
        )}

        <ChatTranscript
          messages={activeMessages}
          roleLabel={roleLabel}
          busy={chatBusy}
          onNavigate={onNavigateLink}
          renderText={renderMessageText}
          emptyHint="No messages yet — start the conversation below."
        />

        {chatError && (
          <div className="analyst-chat-error">
            <span>{chatError}</span>
            {chatErrorIsLlmNotConfigured ? (
              <button type="button" onClick={onOpenSettings}>
                Open Settings
              </button>
            ) : (
              <button type="button" onClick={() => void doSend()}>
                Retry
              </button>
            )}
          </div>
        )}

        {renderExtras?.()}

        <div className="analyst-chat-input-row">
          <textarea
            ref={inputRef}
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void doSend()
              }
            }}
            placeholder={placeholder}
          />
          <button type="button" onClick={() => void doSend()} disabled={!chatInput.trim() || chatBusy}>
            Send
          </button>
        </div>
    </div>
  )

  if (variant === 'embedded') return panel

  return (
    <div className="analyst-chat-dock chat-dock" style={{ height: chatHeight }}>
      <div className="analyst-chat-resize-handle" onMouseDown={handleResizeStart} />
      {panel}
    </div>
  )
}
