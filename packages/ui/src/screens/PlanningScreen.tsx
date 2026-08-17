import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  Architecture,
  ArchitectureElement,
  Backlog,
  CurrentOperation,
  MigrationPlanRecord,
  ProjectMode,
  ProposedStory,
  Story,
  VicCoreApi,
} from '../api/types'
import { toOperationError } from '../api/errorCode'
import { STATUS_COLOR, STATUS_LABEL } from '../statusColor'
import { highlightRequirementIds } from './requirementIdHighlight'
import { EditableStoryProposalCard } from './EditableStoryProposalCard'
import './RequirementsScreen.css'
import './PlanningScreen.css'

interface PlanningChatEntry {
  role: 'user' | 'pm'
  text: string
}

const DEFAULT_CHAT_HEIGHT = 260
const MIN_CHAT_HEIGHT = 120
const MAX_CHAT_HEIGHT = 640

interface PlanningScreenProps {
  api: VicCoreApi
  projectId: string
  onOperationChange: (op: CurrentOperation) => void
  projectMode: ProjectMode
  onOpenSettings: () => void
}

// Plain labeled badges rather than STATUS_COLOR — MigrationAction
// (reuse-as-is/refactor-in-place/rewrite) doesn't map cleanly onto the
// existing not-started/in-progress/blocked/complete lifecycle scale.
const ACTION_LABEL: Record<MigrationPlanRecord['stories'][number]['action'], string> = {
  'reuse-as-is': 'Reuse as-is',
  'refactor-in-place': 'Refactor in place',
  rewrite: 'Rewrite',
}

// Planning phase entry point — branches on projectMode since 'import' and
// 'new' projects need entirely different Planning content (migration plan
// vs. real backlog/stories) that are never both relevant to the same
// project. Kept as one component/tab rather than two, mirroring how
// ArchitectureScreen already receives projectMode for its own import-only
// affordances.
export function PlanningScreen({
  api,
  projectId,
  onOperationChange,
  projectMode,
  onOpenSettings,
}: PlanningScreenProps) {
  if (projectMode === 'import') {
    return <MigrationPlanView api={api} projectId={projectId} onOperationChange={onOperationChange} />
  }
  return (
    <BacklogView
      api={api}
      projectId={projectId}
      onOperationChange={onOperationChange}
      onOpenSettings={onOpenSettings}
    />
  )
}

function MigrationPlanView({
  api,
  projectId,
  onOperationChange,
}: Pick<PlanningScreenProps, 'api' | 'projectId' | 'onOperationChange'>) {
  const [generating, setGenerating] = useState(false)
  const [plan, setPlan] = useState<MigrationPlanRecord | null>(null)
  const [elementNameById, setElementNameById] = useState<Map<string, string>>(new Map())

  useEffect(() => {
    let cancelled = false
    api.getArchitecture(projectId).then((arch) => {
      if (cancelled || !arch) return
      setElementNameById(new Map(arch.elements.map((e) => [e.id, e.name])))
    })
    return () => {
      cancelled = true
    }
  }, [api, projectId])

  async function handleGenerate() {
    if (generating) return
    setGenerating(true)
    onOperationChange({ text: 'Generating migration plan...' })
    try {
      const result = await api.generateMigrationPlan(projectId)
      setPlan(result)
      onOperationChange({ text: null })
    } catch (err) {
      onOperationChange(toOperationError(err))
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div className="planning-screen">
      <h1>Planning — Migration Plan</h1>
      <p className="planning-screen-hint">
        Generates one migration story per architecture element, derived from the most recent code
        alignment analysis — run Analyze Code Alignment on the Architecture tab first if this
        button stays disabled.
      </p>

      <div className="planning-action-bar">
        <button type="button" onClick={handleGenerate} disabled={generating}>
          {generating ? 'Generating...' : 'Generate Migration Plan'}
        </button>
      </div>

      {plan && (
        <ul className="planning-story-list">
          {plan.stories.map((story) => (
            <li key={story.id} className="planning-story-card">
              <div className="planning-story-header">
                <span className="planning-story-element">
                  {elementNameById.get(story.architectureElementId) ?? story.architectureElementId}
                </span>
                <span className={`planning-action-badge planning-action-badge-${story.action}`}>
                  {ACTION_LABEL[story.action]}
                </span>
              </div>
              <p className="planning-story-rationale">{story.rationale}</p>
            </li>
          ))}
        </ul>
      )}

      {plan && plan.stories.length === 0 && (
        <p className="planning-screen-hint">No stories yet — no architecture elements found.</p>
      )}
    </div>
  )
}

type PlanningView = 'board' | 'dependency' | 'research'

function BacklogView({
  api,
  projectId,
  onOperationChange,
  onOpenSettings,
}: Pick<PlanningScreenProps, 'api' | 'projectId' | 'onOperationChange' | 'onOpenSettings'>) {
  const [backlog, setBacklog] = useState<Backlog | null>(null)
  const [architecture, setArchitecture] = useState<Architecture | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [view, setView] = useState<PlanningView>('board')
  const [busy, setBusy] = useState(false)
  const [selectedElementId, setSelectedElementId] = useState<string>('')

  const [chatHistory, setChatHistory] = useState<PlanningChatEntry[]>([])
  const [chatInput, setChatInput] = useState('')
  const [proposedStories, setProposedStories] = useState<ProposedStory[]>([])
  const [chatBusy, setChatBusy] = useState(false)
  const [chatError, setChatError] = useState<string | null>(null)
  const [chatErrorIsLlmNotConfigured, setChatErrorIsLlmNotConfigured] = useState(false)
  const [chatHeight, setChatHeight] = useState(DEFAULT_CHAT_HEIGHT)
  const resizingRef = useRef(false)

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      resizingRef.current = true
      const startY = e.clientY
      const startHeight = chatHeight

      function onMove(moveEvent: MouseEvent) {
        if (!resizingRef.current) return
        const delta = startY - moveEvent.clientY
        const next = Math.min(MAX_CHAT_HEIGHT, Math.max(MIN_CHAT_HEIGHT, startHeight + delta))
        setChatHeight(next)
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

  async function reload() {
    try {
      const [b, a] = await Promise.all([api.getBacklog(projectId), api.getArchitecture(projectId)])
      setBacklog(b)
      setArchitecture(a)
      setLoadError(null)
    } catch (err) {
      setLoadError(toOperationError(err).error ?? 'Failed to load Planning data.')
    }
  }

  useEffect(() => {
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, projectId])

  const elementNameById = new Map((architecture?.elements ?? []).map((e) => [e.id, e.name]))
  const stories = (backlog?.stories ?? []).filter((s) => !s.deletedAt)

  async function withBusyAction(text: string, action: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    onOperationChange({ text })
    try {
      await action()
      onOperationChange({ text: null })
    } catch (err) {
      onOperationChange(toOperationError(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleGenerateForElement() {
    if (!selectedElementId) return
    await withBusyAction('PM is generating stories...', async () => {
      await api.generateStories(projectId, selectedElementId)
      await reload()
    })
  }

  async function handleGenerateAll() {
    await withBusyAction('PM is generating stories...', async () => {
      await api.generateAllStories(projectId)
      await reload()
    })
  }

  async function handleSequence() {
    await withBusyAction('Sequencing stories...', async () => {
      await api.sequenceStories(projectId)
      await reload()
    })
  }

  async function handleResearch(storyId: string) {
    await withBusyAction('PM is researching implementation options...', async () => {
      await api.researchStory(projectId, storyId)
      await reload()
    })
  }

  async function handleChatSend() {
    if (!chatInput.trim() || chatBusy) return
    const message = chatInput.trim()
    setChatHistory((prev) => [...prev, { role: 'user', text: message }])
    setChatInput('')
    setChatBusy(true)
    setChatError(null)
    setChatErrorIsLlmNotConfigured(false)
    onOperationChange({ text: 'PM is thinking...' })
    try {
      const result = await api.planningChat(projectId, message)
      setChatHistory((prev) => [...prev, { role: 'pm', text: result.reply }])
      setProposedStories((prev) => [...prev, ...result.proposedStories])
      onOperationChange({ text: null })
    } catch (err) {
      const operationError = toOperationError(err)
      setChatError(operationError.error ?? null)
      setChatErrorIsLlmNotConfigured(operationError.errorCode === 'llm-not-configured')
      onOperationChange(operationError)
    } finally {
      setChatBusy(false)
    }
  }

  async function handleAcceptStoryProposal(proposal: ProposedStory) {
    const story = await api.acceptProposedStory(projectId, proposal)
    setBacklog((prev) => (prev ? { ...prev, stories: [...prev.stories, story] } : prev))
    setProposedStories((prev) => prev.filter((p) => p !== proposal))
  }

  function handleDiscardStoryProposal(proposal: ProposedStory) {
    setProposedStories((prev) => prev.filter((p) => p !== proposal))
  }

  if (loadError) {
    return (
      <div className="planning-screen">
        <h1>Planning — Backlog</h1>
        <div className="analyst-chat-error">
          <span>{loadError}</span>
          <button type="button" onClick={reload}>
            Retry
          </button>
        </div>
      </div>
    )
  }

  if (!architecture || architecture.elements.length === 0) {
    return (
      <div className="planning-screen">
        <h1>Planning — Backlog</h1>
        <p className="planning-screen-hint">
          No architecture elements yet — add elements on the Architecture tab before planning
          stories.
        </p>
      </div>
    )
  }

  return (
    <div className="planning-screen planning-screen-wide">
      <h1>Planning — Backlog</h1>
      <p className="planning-screen-hint">
        Decompose each architecture element's allocated requirements into stories, sequence them,
        and optionally research implementation options before Coding.
      </p>

      <div className="planning-action-bar">
        <select value={selectedElementId} onChange={(e) => setSelectedElementId(e.target.value)}>
          <option value="">Select an element...</option>
          {architecture.elements.map((e: ArchitectureElement) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
        <button type="button" onClick={handleGenerateForElement} disabled={busy || !selectedElementId}>
          Generate Stories
        </button>
        <button type="button" onClick={handleGenerateAll} disabled={busy}>
          Generate All (unplanned elements)
        </button>
        <button type="button" onClick={handleSequence} disabled={busy}>
          Run Sequencing
        </button>
      </div>

      <div className="planning-view-selector">
        <button
          type="button"
          className={view === 'board' ? 'planning-view-tab planning-view-tab-active' : 'planning-view-tab'}
          onClick={() => setView('board')}
        >
          Board
        </button>
        <button
          type="button"
          className={view === 'dependency' ? 'planning-view-tab planning-view-tab-active' : 'planning-view-tab'}
          onClick={() => setView('dependency')}
        >
          Dependency
        </button>
        <button
          type="button"
          className={view === 'research' ? 'planning-view-tab planning-view-tab-active' : 'planning-view-tab'}
          onClick={() => setView('research')}
        >
          Research
        </button>
      </div>

      {stories.length === 0 ? (
        <p className="planning-screen-hint">No stories yet — select an element and Generate Stories.</p>
      ) : view === 'board' ? (
        <PlanningBoard stories={stories} elementNameById={elementNameById} />
      ) : view === 'dependency' ? (
        <PlanningDependencyView stories={stories} conflicts={backlog?.conflicts ?? []} />
      ) : (
        <PlanningResearchView stories={stories} onResearch={handleResearch} />
      )}

      <div className="analyst-chat-dock" style={{ height: chatHeight }}>
        <div className="analyst-chat-resize-handle" onMouseDown={handleResizeStart} />
        <div className="analyst-chat-panel">
          <div className="analyst-chat-heading-row">
            <h2>PM chat</h2>
            <span className="analyst-chat-hint">
              Ask the PM to help decompose work into stories or think through sequencing.
            </span>
          </div>
          <div className={`analyst-chat-history ${chatHistory.length === 0 ? 'analyst-chat-history-empty' : ''}`}>
            {chatHistory.length === 0 && !chatBusy && (
              <p className="analyst-chat-empty">No messages yet — start the conversation below.</p>
            )}
            {chatHistory.map((entry, i) => (
              <div key={i} className={`analyst-chat-entry analyst-chat-entry-${entry.role}`}>
                <strong>{entry.role === 'user' ? 'You' : 'PM'}</strong>
                <p>{highlightRequirementIds(entry.text)}</p>
              </div>
            ))}
            {chatBusy && <p className="analyst-chat-empty">PM is thinking...</p>}
          </div>

          {chatError && (
            <div className="analyst-chat-error">
              <span>{chatError}</span>
              {chatErrorIsLlmNotConfigured ? (
                <button type="button" onClick={onOpenSettings}>
                  Open Settings
                </button>
              ) : (
                <button type="button" onClick={handleChatSend}>
                  Retry
                </button>
              )}
            </div>
          )}

          {proposedStories.length > 0 && (
            <div className="analyst-chat-proposals">
              <h3>Proposed stories</h3>
              {proposedStories.map((proposal, i) => (
                <EditableStoryProposalCard
                  key={`${proposal.title}-${i}`}
                  proposal={proposal}
                  elementNames={architecture.elements.map((e) => e.name)}
                  onAccept={handleAcceptStoryProposal}
                  onDiscard={handleDiscardStoryProposal}
                />
              ))}
            </div>
          )}

          <div className="analyst-chat-input-row">
            <textarea
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handleChatSend()
                }
              }}
              placeholder="Ask the PM..."
              rows={2}
            />
            <button type="button" onClick={handleChatSend} disabled={!chatInput.trim() || chatBusy}>
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

const BOARD_COLUMNS: Array<{ id: 'not-started' | 'in-progress' | 'complete'; label: string }> = [
  { id: 'not-started', label: 'Backlog' },
  { id: 'in-progress', label: 'In Progress' },
  { id: 'complete', label: 'Done' },
]

function PlanningResearchView({
  stories,
  onResearch,
}: {
  stories: Story[]
  onResearch: (storyId: string) => void
}) {
  return (
    <ul className="planning-story-list">
      {stories.map((story) => (
        <li key={story.id} className="planning-story-card">
          <div className="planning-story-header">
            <span className="planning-story-element">{story.title}</span>
            <button type="button" onClick={() => onResearch(story.id)}>
              Run Research
            </button>
          </div>
          <p className="planning-story-rationale">{story.description}</p>
          {story.research ? (
            <div className="planning-research">
              <ul>
                {story.research.options.map((o) => (
                  <li key={o.name}>
                    <strong>{o.name}</strong> — {o.tradeoffs}
                  </li>
                ))}
              </ul>
              <p>
                <strong>Recommendation:</strong> {story.research.recommendation} — {story.research.rationale}
              </p>
            </div>
          ) : (
            <p className="planning-screen-hint">No research run yet.</p>
          )}
        </li>
      ))}
    </ul>
  )
}

function PlanningBoard({
  stories,
  elementNameById,
}: {
  stories: Story[]
  elementNameById: Map<string, string>
}) {
  return (
    <div className="planning-board">
      {BOARD_COLUMNS.map((col) => (
        <div key={col.id} className="planning-board-column">
          <h2 className="planning-board-column-title">
            <span className="planning-status-dot" style={{ background: STATUS_COLOR[col.id] }} />
            {col.label}
          </h2>
          {stories
            .filter((s) => (col.id === 'not-started' ? s.status !== 'in-progress' && s.status !== 'complete' : s.status === col.id))
            .map((story) => (
              <div key={story.id} className="planning-story-card">
                <div className="planning-story-header">
                  <span className="planning-story-element">{story.title}</span>
                  <span
                    className="planning-status-badge"
                    style={{ background: STATUS_COLOR[story.status] }}
                  >
                    {STATUS_LABEL[story.status]}
                  </span>
                </div>
                <p className="planning-story-rationale">
                  {elementNameById.get(story.architectureElementId ?? '') ?? 'Interface story'}
                </p>
                <p className="planning-story-rationale">{story.description}</p>
              </div>
            ))}
        </div>
      ))}
    </div>
  )
}

function PlanningDependencyView({
  stories,
  conflicts,
}: {
  stories: Story[]
  conflicts: NonNullable<Backlog['conflicts']>
}) {
  const byId = new Map(stories.map((s) => [s.id, s]))
  const ordered = [...stories].sort((a, b) => (a.sequence ?? Infinity) - (b.sequence ?? Infinity))

  return (
    <div>
      {conflicts.length > 0 && (
        <div className="planning-conflict-banner">
          {conflicts.map((c) => (
            <p key={c.id}>{c.rationale}</p>
          ))}
        </div>
      )}
      <ol className="planning-dependency-list">
        {ordered.map((story) => (
          <li key={story.id} id={`story-${story.id}`} className="planning-story-card">
            <div className="planning-story-header">
              <span className="planning-story-element">
                {story.sequence ?? '—'}. {story.title}
              </span>
              <span
                className="planning-status-badge"
                style={{ background: STATUS_COLOR[story.status] }}
              >
                {STATUS_LABEL[story.status]}
              </span>
            </div>
            {story.dependsOn.length > 0 && (
              <div className="planning-dependency-chips">
                Depends on:{' '}
                {story.dependsOn.map((depId) => (
                  <a key={depId} href={`#story-${depId}`} className="planning-dependency-chip">
                    {byId.get(depId)?.title ?? depId}
                  </a>
                ))}
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  )
}
