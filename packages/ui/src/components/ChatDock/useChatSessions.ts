import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ChatMessage,
  ChatSession,
  ChatSessionFocus,
  ChatSurface,
  VicCoreApi,
} from '../../api/types'

// Owns the set of persistent chat tabs for one surface on one screen:
// loading them, which one is active, creating/closing tabs, and appending
// an optimistic turn then reconciling it against what the server stored.
//
// The transport itself lives in the screen (each surface hits a different
// route and has surface-specific side effects like proposal cards), so
// sendTurn takes a `send` callback that returns the two persisted messages.

export interface ChatSessionsController {
  sessions: ChatSession[]
  activeSession: ChatSession | null
  activeSessionId: string | null
  loading: boolean
  loadError: string | null
  selectSession: (id: string) => void
  newSession: () => Promise<void>
  closeSession: (id: string) => Promise<void>
  renameSession: (id: string, title: string) => Promise<void>
  // Appends {user,assistant} optimistically, runs `send`, then replaces the
  // optimistic pair with the server's stored messages (which carry ids,
  // links, dispatch metadata). On failure the optimistic pair is rolled
  // back and the error is rethrown for the screen to surface.
  sendTurn: (
    text: string,
    send: (sessionId: string) => Promise<{ userMessage?: ChatMessage; assistantMessage?: ChatMessage }>,
  ) => Promise<void>
}

const OPTIMISTIC_PREFIX = 'optimistic:'

export function useChatSessions(
  api: VicCoreApi,
  projectId: string,
  surface: ChatSurface,
  currentFocus: ChatSessionFocus | undefined,
): ChatSessionsController {
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  // currentFocus is captured only when a NEW tab is created — keep the
  // latest in a ref so newSession() doesn't need it in a dep array.
  const focusRef = useRef(currentFocus)
  focusRef.current = currentFocus

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    api
      .listChatSessions(projectId, surface)
      .then((loaded) => {
        if (cancelled) return
        setSessions(loaded)
        setActiveSessionId((prev) => {
          if (prev && loaded.some((s) => s.id === prev)) return prev
          // Most-recently-updated non-archived tab, else none (the dock
          // creates the first tab lazily on first send / explicit +).
          const sorted = [...loaded].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          return sorted[0]?.id ?? null
        })
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Failed to load chats')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [api, projectId, surface])

  const selectSession = useCallback((id: string) => setActiveSessionId(id), [])

  const newSession = useCallback(async () => {
    const created = await api.createChatSession(projectId, surface, focusRef.current)
    setSessions((prev) => [...prev, created])
    setActiveSessionId(created.id)
  }, [api, projectId, surface])

  const closeSession = useCallback(
    async (id: string) => {
      await api.updateChatSession(projectId, id, { archivedAt: new Date().toISOString() })
      setSessions((prev) => {
        const remaining = prev.filter((s) => s.id !== id)
        setActiveSessionId((cur) => {
          if (cur !== id) return cur
          const sorted = [...remaining].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          return sorted[0]?.id ?? null
        })
        return remaining
      })
    },
    [api, projectId],
  )

  const renameSession = useCallback(
    async (id: string, title: string) => {
      const updated = await api.updateChatSession(projectId, id, { title })
      setSessions((prev) => prev.map((s) => (s.id === id ? updated : s)))
    },
    [api, projectId],
  )

  const sendTurn = useCallback<ChatSessionsController['sendTurn']>(
    async (text, send) => {
      // Ensure there's a tab to append to.
      let sessionId = activeSessionId
      if (!sessionId) {
        const created = await api.createChatSession(projectId, surface, focusRef.current)
        setSessions((prev) => [...prev, created])
        setActiveSessionId(created.id)
        sessionId = created.id
      }
      const targetId = sessionId

      const now = new Date().toISOString()
      const optimisticUser: ChatMessage = {
        id: `${OPTIMISTIC_PREFIX}${now}:u`,
        role: 'user',
        text,
        createdAt: now,
      }
      const optimisticAssistant: ChatMessage = {
        id: `${OPTIMISTIC_PREFIX}${now}:a`,
        role: 'assistant',
        text: '…',
        createdAt: now,
      }
      setSessions((prev) =>
        prev.map((s) =>
          s.id === targetId ? { ...s, messages: [...s.messages, optimisticUser, optimisticAssistant] } : s,
        ),
      )

      try {
        const { userMessage, assistantMessage } = await send(targetId)
        setSessions((prev) =>
          prev.map((s) => {
            if (s.id !== targetId) return s
            const withoutOptimistic = s.messages.filter(
              (m) => m.id !== optimisticUser.id && m.id !== optimisticAssistant.id,
            )
            const appended = [
              ...withoutOptimistic,
              userMessage ?? { ...optimisticUser, id: `${optimisticUser.id}:kept` },
              assistantMessage ?? { ...optimisticAssistant, id: `${optimisticAssistant.id}:kept` },
            ]
            return { ...s, messages: appended, updatedAt: assistantMessage?.createdAt ?? s.updatedAt }
          }),
        )
      } catch (err) {
        setSessions((prev) =>
          prev.map((s) =>
            s.id === targetId
              ? {
                  ...s,
                  messages: s.messages.filter(
                    (m) => m.id !== optimisticUser.id && m.id !== optimisticAssistant.id,
                  ),
                }
              : s,
          ),
        )
        throw err
      }
    },
    [api, projectId, surface, activeSessionId],
  )

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null

  return {
    sessions,
    activeSession,
    activeSessionId,
    loading,
    loadError,
    selectSession,
    newSession,
    closeSession,
    renameSession,
    sendTurn,
  }
}
