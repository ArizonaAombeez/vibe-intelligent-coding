import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Architecture,
  ArchitectureConflict,
  ArchitectureTypeId,
  ArchitectureTypeOption,
  CheckInterfacesResult,
  CheckInterfaceCodeAlignmentResult,
  CodeAlignmentRecord,
  CreateArchitectureElementFields,
  CurrentOperation,
  PhaseInfo,
  ProjectMode,
  ProposedArchitectureElement,
  ProposedInterface,
  Requirement,
  Status,
  VicCoreApi,
} from '../api/types'
import { STATUS_COLOR, STATUS_LABEL } from '../statusColor'
import { toOperationError } from '../api/errorCode'
import { highlightRequirementIds } from './requirementIdHighlight'
import { ArchitectureGrid } from './ArchitectureGrid'
import { ArchitectureElementFocusView } from './ArchitectureElementFocusView'
import { ArchitectureRequirementList } from './ArchitectureRequirementList'
import { AddArchitectureElementForm } from './AddArchitectureElementForm'
import { EditableElementProposalCard } from './EditableElementProposalCard'
import { MigrationPlanPanel } from './MigrationPlanPanel'
import '../components/ModalOverlay.css'
import './RequirementDetailPanel.css'
import './RequirementsScreen.css'
import './ArchitectureScreen.css'

interface ArchitectureScreenProps {
  api: VicCoreApi
  projectId: string
  phase: PhaseInfo
  activeSubstep: string | null
  onArchitectureTypeChange: (typeId: ArchitectureTypeId) => void
  onOperationChange: (op: CurrentOperation) => void
  onOpenSettings: () => void
  projectMode: ProjectMode
}

interface ChatEntry {
  role: 'user' | 'architect'
  text: string
}

const STATUS_FILTERS: Status[] = ['not-started', 'in-progress', 'blocked', 'complete']

const DEFAULT_CHAT_HEIGHT = 260
const MIN_CHAT_HEIGHT = 120
const MAX_CHAT_HEIGHT = 640

const DEFAULT_SPLIT_FRACTION = 0.5
const MIN_SPLIT_FRACTION = 0.25
const MAX_SPLIT_FRACTION = 0.75

// Aggregates a single element's requirement statuses into the shared
// 4-state scale: any unresolved conflict wins as blocked (matches the
// Requirements screen's status-colour precedence), then blocked if any
// allocated requirement failed its last test run (tested-fail — testing was
// performed for this group and it failed), then in-progress if any allocated
// requirement is short of complete, else complete once every allocated
// requirement has reached it, else not-started (nothing allocated yet).
function deriveElementStatus(
  elementId: string,
  requirements: Requirement[],
  conflictedElementIds: Set<string>,
): Status {
  if (conflictedElementIds.has(elementId)) return 'blocked'
  const allocated = requirements.filter((r) => r.architectureElements.includes(elementId))
  if (allocated.length === 0) return 'not-started'
  if (allocated.some((r) => r.status === 'tested-fail')) return 'blocked'
  if (allocated.every((r) => r.status === 'complete')) return 'complete'
  return 'in-progress'
}

export function ArchitectureScreen({
  api,
  projectId,
  phase,
  activeSubstep,
  onArchitectureTypeChange,
  onOperationChange,
  onOpenSettings,
  projectMode,
}: ArchitectureScreenProps) {
  const [types, setTypes] = useState<ArchitectureTypeOption[]>([])
  const [selectedType, setSelectedType] = useState<ArchitectureTypeId | null>(null)
  const [architecture, setArchitecture] = useState<Architecture | null>(null)
  const [requirements, setRequirements] = useState<Requirement[]>([])
  const [loading, setLoading] = useState(true)

  const [selectedElementId, setSelectedElementId] = useState<string | null>(null)
  // Which requirement row is expanded in the left-hand requirement list —
  // only one open at a time, same "one thing expanded" rule the diagram's
  // zoom already follows.
  const [expandedRequirementId, setExpandedRequirementId] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<Status | null>(null)
  const [addFormOpen, setAddFormOpen] = useState(false)
  const [checkingConflicts, setCheckingConflicts] = useState(false)
  const [autoConfiguring, setAutoConfiguring] = useState(false)
  const [autoAllocating, setAutoAllocating] = useState(false)
  const [analyzingAlignment, setAnalyzingAlignment] = useState(false)
  const [codeAlignment, setCodeAlignment] = useState<CodeAlignmentRecord | null>(null)
  const [alignmentPanelOpen, setAlignmentPanelOpen] = useState(false)
  const [draggingRequirementId, setDraggingRequirementId] = useState<string | null>(null)
  const [dropTargetElementId, setDropTargetElementId] = useState<string | null>(null)
  const [interfaceConflictResult, setInterfaceConflictResult] = useState<ArchitectureConflict | null | undefined>(
    undefined,
  )
  const [definingInterfaces, setDefiningInterfaces] = useState(false)
  const [checkingInterfaces, setCheckingInterfaces] = useState(false)
  const [interfacesCheckResult, setInterfacesCheckResult] = useState<CheckInterfacesResult | null>(null)
  const [checkingCodeAlignment, setCheckingCodeAlignment] = useState(false)
  const [codeAlignmentCheckResult, setCodeAlignmentCheckResult] = useState<CheckInterfaceCodeAlignmentResult | null>(
    null,
  )

  const [chatHistory, setChatHistory] = useState<ChatEntry[]>([])
  const [chatInput, setChatInput] = useState('')
  const [proposedElements, setProposedElements] = useState<ProposedArchitectureElement[]>([])
  const [proposedInterfaces, setProposedInterfaces] = useState<ProposedInterface[]>([])
  const [chatBusy, setChatBusy] = useState(false)
  const [chatError, setChatError] = useState<string | null>(null)
  const [chatErrorIsLlmNotConfigured, setChatErrorIsLlmNotConfigured] = useState(false)
  const [chatHeight, setChatHeight] = useState(DEFAULT_CHAT_HEIGHT)
  const chatResizingRef = useRef(false)
  const chatInputRef = useRef<HTMLTextAreaElement>(null)

  const [splitFraction, setSplitFraction] = useState(DEFAULT_SPLIT_FRACTION)
  const splitResizingRef = useRef(false)
  const layoutRef = useRef<HTMLDivElement>(null)

  const handleSplitResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const containerWidth = layoutRef.current?.getBoundingClientRect().width
      const containerLeft = layoutRef.current?.getBoundingClientRect().left
      if (!containerWidth || containerLeft === undefined) return
      splitResizingRef.current = true

      function onMove(moveEvent: MouseEvent) {
        if (!splitResizingRef.current) return
        const next = Math.min(
          MAX_SPLIT_FRACTION,
          Math.max(MIN_SPLIT_FRACTION, (moveEvent.clientX - containerLeft!) / containerWidth!),
        )
        setSplitFraction(next)
      }
      function onUp() {
        splitResizingRef.current = false
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [],
  )

  const loadArchitecture = useCallback(async () => {
    const [arch, reqs] = await Promise.all([
      api.getArchitecture(projectId),
      api.listRequirements(projectId),
    ])
    setArchitecture(arch)
    setRequirements(reqs)
  }, [api, projectId])

  useEffect(() => {
    let cancelled = false
    Promise.all([api.listArchitectureTypes(), api.getArchitectureType(projectId)]).then(
      async ([typeOptions, current]) => {
        if (cancelled) return
        setTypes(typeOptions)
        setSelectedType(current)
        if (current) await loadArchitecture()
        setLoading(false)
      },
    )
    return () => {
      cancelled = true
    }
  }, [api, projectId, loadArchitecture])

  async function handleSelectType(typeId: ArchitectureTypeId) {
    setSelectedType(typeId)
    await api.setArchitectureType(projectId, typeId)
    onArchitectureTypeChange(typeId)
    await loadArchitecture()
  }

  async function handleAddElement(fields: CreateArchitectureElementFields) {
    await api.createArchitectureElement(projectId, fields)
    await loadArchitecture()
  }

  async function handleSaveElement(
    elementId: string,
    fields: { name: string; responsibility: string; interfaces: string[] },
  ) {
    await api.updateArchitectureElement(projectId, elementId, fields)
    await loadArchitecture()
  }

  async function handleDeleteElement(elementId: string) {
    await api.deleteArchitectureElement(projectId, elementId)
    if (selectedElementId === elementId) setSelectedElementId(null)
    await loadArchitecture()
  }

  async function handleToggleDynamicDesign(elementId: string, enabled: boolean) {
    await api.updateArchitectureElement(projectId, elementId, { dynamicDesignEnabled: enabled })
    await loadArchitecture()
  }

  const handleSelectElement = useCallback((elementId: string) => {
    setSelectedElementId(elementId)
  }, [])

  const handleBackToArchitecture = useCallback(() => {
    setSelectedElementId(null)
  }, [])

  async function handleSaveAllocationRationale(requirementId: string, rationale: string) {
    const updated = await api.setAllocationRationale(projectId, requirementId, rationale)
    setRequirements((prev) => prev.map((r) => (r.id === updated.id ? updated : r)))
  }

  const handleFocusSelectInterface = useCallback((targetId: string) => {
    setSelectedElementId(targetId)
  }, [])

  const handleFocusSelectRequirement = useCallback((requirementId: string) => {
    setExpandedRequirementId(requirementId)
  }, [])

  const handleDropRequirements = useCallback(
    async (elementId: string, requirementIds: string[]) => {
      // Always adds (never replaces) — a requirement dropped on an element
      // it's already allocated to is a no-op, but dropping it onto a
      // SECOND element adds that allocation alongside the first rather than
      // moving it (multi-element allocation, confirmed design decision).
      const toAdd = requirementIds.filter((id) => {
        const requirement = requirements.find((r) => r.id === id)
        return requirement && !requirement.architectureElements.includes(elementId)
      })
      if (toAdd.length === 0) return
      const updated = await Promise.all(toAdd.map((id) => api.addRequirementToElement(projectId, id, elementId)))
      setRequirements((prev) => prev.map((r) => updated.find((u) => u.id === r.id) ?? r))
    },
    [requirements, api, projectId],
  )

  async function handleCheckConflicts() {
    if (checkingConflicts) return
    setCheckingConflicts(true)
    onOperationChange({ text: 'Checking conflicts...' })
    try {
      await api.checkArchitectureConflicts(projectId)
      await loadArchitecture()
      onOperationChange({ text: null })
    } catch (err) {
      onOperationChange(toOperationError(err))
    } finally {
      setCheckingConflicts(false)
    }
  }

  async function handleDefineInterfaces() {
    if (definingInterfaces) return
    setDefiningInterfaces(true)
    onOperationChange({ text: 'Architect is defining interfaces...' })
    try {
      await api.defineAllArchitectureInterfaceContracts(projectId)
      await loadArchitecture()
      onOperationChange({ text: null })
    } catch (err) {
      onOperationChange(toOperationError(err))
    } finally {
      setDefiningInterfaces(false)
    }
  }

  async function handleCheckInterfaces() {
    if (checkingInterfaces) return
    setCheckingInterfaces(true)
    try {
      const result = await api.checkArchitectureInterfaces(projectId)
      setInterfacesCheckResult(result)
    } catch (err) {
      onOperationChange(toOperationError(err))
    } finally {
      setCheckingInterfaces(false)
    }
  }

  async function handleCheckCodeAlignment() {
    if (checkingCodeAlignment) return
    setCheckingCodeAlignment(true)
    try {
      const result = await api.checkArchitectureInterfaceCodeAlignment(projectId)
      setCodeAlignmentCheckResult(result)
    } catch (err) {
      onOperationChange(toOperationError(err))
    } finally {
      setCheckingCodeAlignment(false)
    }
  }

  async function handleAutoConfigureAndAllocate() {
    if (autoConfiguring) return
    setAutoConfiguring(true)
    onOperationChange({ text: 'Auto-configuring and allocating...' })
    try {
      const result = await api.autoConfigureAndAllocate(projectId)
      await loadArchitecture()
      onOperationChange({
        text:
          result.unallocatedRequirementIds.length > 0
            ? `Created ${result.createdElements.length} module(s); ${result.unallocatedRequirementIds.length} requirement(s) could not be confidently allocated.`
            : null,
      })
    } catch (err) {
      onOperationChange(toOperationError(err))
    } finally {
      setAutoConfiguring(false)
    }
  }

  async function handleAutoAllocate(mode: 'heuristic' | 'llm') {
    if (autoAllocating) return
    setAutoAllocating(true)
    onOperationChange({ text: mode === 'heuristic' ? 'Allocating requirements...' : 'Architect is allocating requirements...' })
    try {
      const result = await api.autoAllocate(projectId, mode)
      await loadArchitecture()
      onOperationChange({
        text:
          result.unallocatedRequirementIds.length > 0
            ? `Allocated ${result.allocatedRequirementIds.length} requirement(s); ${result.unallocatedRequirementIds.length} could not be confidently allocated.`
            : null,
      })
    } catch (err) {
      onOperationChange(toOperationError(err))
    } finally {
      setAutoAllocating(false)
    }
  }

  async function handleAnalyzeCodeAlignment() {
    if (analyzingAlignment) return
    setAnalyzingAlignment(true)
    onOperationChange({ text: 'Analysing code alignment...' })
    try {
      const result = await api.analyzeCodeAlignment(projectId)
      setCodeAlignment(result)
      setAlignmentPanelOpen(true)
      onOperationChange({ text: null })
    } catch (err) {
      onOperationChange(toOperationError(err))
    } finally {
      setAnalyzingAlignment(false)
    }
  }

  async function handleChatSend() {
    if (!chatInput.trim() || chatBusy) return
    const message = chatInput.trim()
    setChatHistory((prev) => [...prev, { role: 'user', text: message }])
    setChatInput('')
    setChatBusy(true)
    setChatError(null)
    setChatErrorIsLlmNotConfigured(false)
    onOperationChange({ text: 'Architect is thinking...' })
    try {
      const result = await api.architectChat(projectId, message)
      setChatHistory((prev) => [...prev, { role: 'architect', text: result.reply }])
      setProposedElements((prev) => [...prev, ...result.proposedElements])
      setProposedInterfaces((prev) => [...prev, ...result.proposedInterfaces])
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

  async function handleAcceptProposedElement(
    proposal: ProposedArchitectureElement,
    original: ProposedArchitectureElement,
  ) {
    await api.acceptProposedArchitectureElement(projectId, proposal)
    await loadArchitecture()
    setProposedElements((prev) => prev.filter((p) => p !== original))
  }

  function handleDiscardProposedElement(proposal: ProposedArchitectureElement) {
    setProposedElements((prev) => prev.filter((p) => p !== proposal))
  }

  async function handleAcceptProposedInterface(proposal: ProposedInterface) {
    const from = architecture?.elements.find((e) => e.name === proposal.from)
    const to = architecture?.elements.find((e) => e.name === proposal.to)
    if (!from || !to) return
    await api.acceptProposedArchitectureInterface(projectId, from.id, to.id)
    await loadArchitecture()
    setProposedInterfaces((prev) => prev.filter((p) => p !== proposal))
  }

  function handleDiscardProposedInterface(proposal: ProposedInterface) {
    setProposedInterfaces((prev) => prev.filter((p) => p !== proposal))
  }

  const handleChatResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      chatResizingRef.current = true
      const startY = e.clientY
      const startHeight = chatHeight

      function onMove(moveEvent: MouseEvent) {
        if (!chatResizingRef.current) return
        const delta = startY - moveEvent.clientY
        const next = Math.min(MAX_CHAT_HEIGHT, Math.max(MIN_CHAT_HEIGHT, startHeight + delta))
        setChatHeight(next)
      }
      function onUp() {
        chatResizingRef.current = false
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [chatHeight],
  )

  async function handleRemoveInterface(fromId: string, toId: string) {
    const from = architecture?.elements.find((e) => e.id === fromId)
    const to = architecture?.elements.find((e) => e.id === toId)
    const label = `${from?.name ?? fromId} → ${to?.name ?? toId}`
    if (!window.confirm(`Remove the interface "${label}"? This cannot be undone.`)) return
    await api.removeArchitectureInterface(projectId, fromId, toId)
    await loadArchitecture()
  }

  async function handleCheckInterfaceConflict(fromId: string, toId: string) {
    onOperationChange({ text: 'Architect is checking the interface...' })
    try {
      const conflict = await api.checkArchitectureInterfaceConflict(projectId, fromId, toId)
      setInterfaceConflictResult(conflict)
      onOperationChange({ text: null })
    } catch (err) {
      onOperationChange(toOperationError(err))
    }
  }

  function handleAskArchitectAboutInterface(fromId: string, toId: string) {
    const from = architecture?.elements.find((e) => e.id === fromId)
    const to = architecture?.elements.find((e) => e.id === toId)
    setChatInput(`Review the interface between ${from?.name ?? fromId} and ${to?.name ?? toId}.`)
    chatInputRef.current?.focus()
    chatInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  const conflicts: ArchitectureConflict[] = useMemo(
    () => architecture?.conflicts ?? [],
    [architecture],
  )
  const conflictedElementIds = useMemo(
    () => new Set(conflicts.flatMap((c) => c.elementIds)),
    [conflicts],
  )

  const statusByElementId = useMemo(() => {
    const map = new Map<string, Status>()
    if (!architecture) return map
    for (const element of architecture.elements) {
      map.set(element.id, deriveElementStatus(element.id, requirements, conflictedElementIds))
    }
    return map
  }, [architecture, requirements, conflictedElementIds])

  const requirementCountByElementId = useMemo(() => {
    const map = new Map<string, number>()
    for (const requirement of requirements) {
      for (const elementId of requirement.architectureElements) {
        map.set(elementId, (map.get(elementId) ?? 0) + 1)
      }
    }
    return map
  }, [requirements])

  const hasElements = (architecture?.elements.length ?? 0) > 0

  const alignmentCounts = useMemo(() => {
    if (!codeAlignment) return null
    let aligned = 0
    let partial = 0
    let unmapped = 0
    for (const mapping of codeAlignment.mappings) {
      if (mapping.architectureElementId === null) unmapped++
      else if (mapping.status === 'aligned') aligned++
      else if (mapping.status === 'partially-aligned') partial++
    }
    return { aligned, partial, unmapped }
  }, [codeAlignment])

  const unmappedFiles = useMemo(
    () => codeAlignment?.mappings.filter((m) => m.architectureElementId === null) ?? [],
    [codeAlignment],
  )

  const substepLabel = phase.substeps.find((s) => s.id === activeSubstep)?.label
  // selectedType can be a stale/unknown id (e.g. an imported architecture.json
  // written by an older tool version whose preset list has since changed) —
  // architecture itself may already exist and have real elements in that
  // case, so the action bar must not stay hidden just because the type
  // label can't be resolved. unknownSelectedType flags this so the type
  // line can surface it instead of silently reverting to the picker.
  const selectedOption = types.find((t) => t.id === selectedType) ?? null
  const unknownSelectedType = selectedType !== null && selectedOption === null
  const focusElement = architecture?.elements.find((e) => e.id === selectedElementId) ?? null
  const focusElementRequirements = selectedElementId
    ? requirements.filter((r) => r.architectureElements.includes(selectedElementId))
    : []
  const focusElementConflicts = selectedElementId
    ? conflicts.filter((c) => c.elementIds.includes(selectedElementId))
    : []
  const unallocatedRequirementCount = requirements.filter((r) => r.architectureElements.length === 0).length
  // A requirement allocated to multiple elements takes the "worst" status
  // across all of them (blocked wins, then in-progress, then complete only
  // if every allocated element's derived status agrees) — same precedence
  // deriveElementStatus already uses for a single element's own rollup.
  const statusByRequirementId = useMemo(() => {
    const map = new Map<string, Status>()
    for (const requirement of requirements) {
      if (requirement.architectureElements.length === 0) {
        map.set(requirement.id, 'not-started')
        continue
      }
      const elementStatuses = requirement.architectureElements.map(
        (elementId) => statusByElementId.get(elementId) ?? 'not-started',
      )
      let status: Status = 'complete'
      if (elementStatuses.includes('blocked')) status = 'blocked'
      else if (elementStatuses.some((s) => s !== 'complete')) status = 'in-progress'
      map.set(requirement.id, status)
    }
    return map
  }, [requirements, statusByElementId])

  // Whether the toolbar/grid should render — an unrecognised-but-set type
  // (see unknownSelectedType above) must not block this: the architecture
  // itself (layers/elements) is real and already loaded, so hiding every
  // action behind an unresolvable label would strand the user with no way
  // to even fix the type. Only a genuinely never-selected type (selectedType
  // === null) keeps the picker as the sole thing on screen.
  const showArchitectureWorkspace = !loading && architecture !== null && (selectedOption !== null || unknownSelectedType)

  return (
    <div className="architecture-screen">
      <div className="architecture-title-row">
        <h1>Architecture</h1>
        {showArchitectureWorkspace && (
          <div className="architecture-status-filters">
            <button
              type="button"
              className={`architecture-status-filter ${statusFilter === null ? 'active' : ''}`}
              onClick={() => setStatusFilter(null)}
            >
              All
            </button>
            {STATUS_FILTERS.map((status) => (
              <button
                key={status}
                type="button"
                className={`architecture-status-filter ${statusFilter === status ? 'active' : ''}`}
                onClick={() => setStatusFilter(status)}
              >
                <span className="architecture-status-dot" style={{ background: STATUS_COLOR[status] }} />
                {STATUS_LABEL[status]}
              </button>
            ))}
          </div>
        )}
      </div>
      {substepLabel && <p className="architecture-screen-substep">{substepLabel}</p>}

      <section className="architecture-type-selector">
        {selectedOption ? (
          <p className="architecture-type-line">
            Architecture type: <strong>{selectedOption.label}</strong> ·{' '}
            <button
              type="button"
              className="architecture-type-change-link"
              onClick={() => setSelectedType(null)}
            >
              Change
            </button>
          </p>
        ) : unknownSelectedType ? (
          <p className="architecture-type-line architecture-type-line-warning">
            Architecture type <strong>"{selectedType}"</strong> isn't a recognised preset (likely imported from an
            older export) — existing layers/elements are unaffected, but pick a current type to restore the label. ·{' '}
            <button
              type="button"
              className="architecture-type-change-link"
              onClick={() => setSelectedType(null)}
            >
              Choose type
            </button>
          </p>
        ) : (
          <>
            <h2>Architecture type</h2>
            <p className="architecture-type-hint">
              Select the architecture type that best matches this project's needs. This sets the
              default grid layout (layer rows) and dynamic-design behaviour — both can still be
              adjusted afterward.
            </p>
          </>
        )}
        {loading ? (
          <p className="architecture-type-hint">Loading...</p>
        ) : !selectedOption && !unknownSelectedType ? (
          <div className="architecture-type-grid">
            {types.map((type) => (
              <button
                key={type.id}
                type="button"
                className={`architecture-type-card ${selectedType === type.id ? 'selected' : ''}`}
                onClick={() => handleSelectType(type.id)}
              >
                <span className="architecture-type-card-label">{type.label}</span>
                <span className="architecture-type-card-description">{type.description}</span>
              </button>
            ))}
          </div>
        ) : null}
      </section>

      {!loading && !selectedOption && !unknownSelectedType && (
        <p className="architecture-screen-note">Select an architecture type above to continue.</p>
      )}

      {showArchitectureWorkspace && (
        <div className="architecture-layout" ref={layoutRef}>
          <div className="architecture-left-col" style={{ flexBasis: `${splitFraction * 100}%` }}>
            <div className="architecture-action-box">
              <div className="architecture-action-bar">
                <button type="button" onClick={() => setAddFormOpen(true)}>
                  Add element
                </button>
                <button
                  type="button"
                  className="architecture-action-secondary"
                  onClick={handleAutoConfigureAndAllocate}
                  disabled={autoConfiguring || hasElements}
                  title={
                    hasElements
                      ? 'Architecture elements already exist — use Auto Allocate to allocate onto them, or delete existing elements first.'
                      : 'Groups unallocated requirements into modules, creates the architecture elements, connects their interfaces, and allocates the requirements.'
                  }
                >
                  {autoConfiguring ? 'Auto Configuring...' : 'Auto Configure & Allocate'}
                </button>
                <button
                  type="button"
                  className="architecture-action-secondary"
                  onClick={() => handleAutoAllocate('heuristic')}
                  disabled={autoAllocating || !hasElements}
                  title={
                    hasElements
                      ? 'Allocates unallocated requirements onto existing elements using local keyword matching — no LLM call.'
                      : 'Add at least one architecture element first.'
                  }
                >
                  {autoAllocating ? 'Allocating...' : 'Auto Allocate (Heuristic)'}
                </button>
                <button
                  type="button"
                  className="architecture-action-secondary"
                  onClick={() => handleAutoAllocate('llm')}
                  disabled={autoAllocating || !hasElements}
                  title={
                    hasElements
                      ? 'Allocates unallocated requirements onto existing elements using the Architect (LLM).'
                      : 'Add at least one architecture element first.'
                  }
                >
                  {autoAllocating ? 'Allocating...' : 'Auto Allocate (LLM)'}
                </button>
                <button
                  type="button"
                  className="architecture-action-secondary"
                  onClick={handleCheckConflicts}
                  disabled={checkingConflicts}
                  title="Checks for interface/contract mismatches, overlapping responsibilities, and circular dependencies."
                >
                  Check Conflicts{conflicts.length > 0 ? ` (${conflicts.length})` : ''}
                </button>
                <button
                  type="button"
                  className="architecture-action-secondary"
                  onClick={handleDefineInterfaces}
                  disabled={definingInterfaces || !hasElements}
                  title="Has the Architect define a structured contract (operations, request/response shape) for every connected pair that doesn't have one yet."
                >
                  {definingInterfaces ? 'Defining Interfaces...' : 'Define Interfaces'}
                </button>
                <button
                  type="button"
                  className="architecture-action-secondary"
                  onClick={handleCheckInterfaces}
                  disabled={checkingInterfaces || !hasElements}
                  title="Checks that every connected pair has a defined interface contract before you move on to coding."
                >
                  {checkingInterfaces ? 'Checking Interfaces...' : 'Check Interfaces'}
                </button>
                <button
                  type="button"
                  className="architecture-action-secondary"
                  onClick={handleCheckCodeAlignment}
                  disabled={checkingCodeAlignment || !hasElements}
                  title="Compares each defined interface contract's operations against the generated source tree: flags contract operations no code appears to implement, and code that appears to implement an interface the Architecture never defined."
                >
                  {checkingCodeAlignment ? 'Checking Code Alignment...' : 'Check Interface/Code Alignment'}
                </button>
                {projectMode === 'import' && (
                  <button
                    type="button"
                    className="architecture-action-secondary"
                    onClick={handleAnalyzeCodeAlignment}
                    disabled={analyzingAlignment}
                    title="Compares the imported codebase's files against this confirmed architecture."
                  >
                    {analyzingAlignment ? 'Analysing Alignment...' : 'Analyze Code Alignment'}
                  </button>
                )}
              </div>

              {alignmentCounts && (
                <div className="architecture-alignment-summary">
                  <span className="architecture-req-tray-label">Code alignment</span>
                  <span className="quality-score-badge" style={{ background: 'var(--status-green)' }}>
                    {alignmentCounts.aligned} aligned
                  </span>
                  <span className="quality-score-badge" style={{ background: 'var(--status-amber)' }}>
                    {alignmentCounts.partial} partial
                  </span>
                  <button
                    type="button"
                    className="conflict-badge"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                    onClick={() => setAlignmentPanelOpen(true)}
                    title="Files that couldn't be mapped to any architecture element — review in the panel."
                  >
                    ⚠ {alignmentCounts.unmapped} unmapped
                  </button>
                </div>
              )}
            </div>

            <div className="architecture-req-list-panel">
              <h2 className="architecture-req-list-heading">
                Requirements{requirements.length > 0 ? ` (${requirements.length})` : ''}
                {unallocatedRequirementCount > 0 && (
                  <span className="architecture-req-list-unallocated-count">
                    {' '}
                    — {unallocatedRequirementCount} unallocated
                  </span>
                )}
              </h2>
              <div className="architecture-req-list-scroll">
                <ArchitectureRequirementList
                  requirements={requirements}
                  architecture={architecture}
                  statusByRequirementId={statusByRequirementId}
                  expandedRequirementId={expandedRequirementId}
                  onExpandedRequirementIdChange={setExpandedRequirementId}
                  draggingRequirementId={draggingRequirementId}
                  onDragStart={setDraggingRequirementId}
                  onDragEnd={() => {
                    setDraggingRequirementId(null)
                    setDropTargetElementId(null)
                  }}
                  onSaveRationale={handleSaveAllocationRationale}
                  activeElementId={selectedElementId}
                />
              </div>
            </div>

            {projectMode === 'import' && (
              <div className="architecture-migration-plan-panel">
                <MigrationPlanPanel api={api} projectId={projectId} onOperationChange={onOperationChange} />
              </div>
            )}

            <div className="analyst-chat-dock" style={{ height: chatHeight }}>
              <div className="analyst-chat-resize-handle" onMouseDown={handleChatResizeStart} />
              <div className="analyst-chat-panel">
                <div className="analyst-chat-heading-row">
                  <h2>Architect chat</h2>
                  <span className="analyst-chat-hint">
                    Ask the Architect to help design, extend, or refine the architecture.
                  </span>
                </div>
                <div
                  className={`analyst-chat-history ${chatHistory.length === 0 ? 'analyst-chat-history-empty' : ''}`}
                >
                  {chatHistory.length === 0 && !chatBusy && (
                    <p className="analyst-chat-empty">No messages yet — start the conversation below.</p>
                  )}
                  {chatHistory.map((entry, i) => (
                    <div key={i} className={`analyst-chat-entry analyst-chat-entry-${entry.role}`}>
                      <strong>{entry.role === 'user' ? 'You' : 'Architect'}</strong>
                      <p>{highlightRequirementIds(entry.text)}</p>
                    </div>
                  ))}
                  {chatBusy && <p className="analyst-chat-empty">Architect is thinking...</p>}
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

                {proposedElements.length > 0 && (
                  <div className="analyst-chat-proposals">
                    <h3>Proposed elements</h3>
                    {proposedElements.map((proposal, i) => (
                      <EditableElementProposalCard
                        key={`${proposal.name}-${i}`}
                        proposal={proposal}
                        layers={architecture?.layers ?? []}
                        onAccept={(edited) => handleAcceptProposedElement(edited, proposal)}
                        onDiscard={handleDiscardProposedElement}
                      />
                    ))}
                  </div>
                )}

                {proposedInterfaces.length > 0 && (
                  <div className="analyst-chat-proposals">
                    <h3>Proposed interfaces</h3>
                    {proposedInterfaces.map((proposal, i) => {
                      const bothExist =
                        architecture?.elements.some((e) => e.name === proposal.from) &&
                        architecture?.elements.some((e) => e.name === proposal.to)
                      return (
                        <div key={`${proposal.from}-${proposal.to}-${i}`} className="analyst-chat-proposal">
                          <p>
                            <strong>{proposal.from}</strong> → <strong>{proposal.to}</strong>
                          </p>
                          <div className="analyst-chat-proposal-actions">
                            <button
                              type="button"
                              onClick={() => handleAcceptProposedInterface(proposal)}
                              disabled={!bothExist}
                              title={bothExist ? undefined : 'Accept its elements above first'}
                            >
                              Accept
                            </button>
                            <button type="button" onClick={() => handleDiscardProposedInterface(proposal)}>
                              Discard
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}

                <div className="analyst-chat-input-row">
                  <textarea
                    ref={chatInputRef}
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        handleChatSend()
                      }
                    }}
                    placeholder="Message the Architect... (Shift+Enter for a new line)"
                  />
                  <button type="button" onClick={handleChatSend} disabled={!chatInput.trim() || chatBusy}>
                    Send
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="architecture-split-resize-handle" onMouseDown={handleSplitResizeStart} />

          <div className="architecture-right-col">
            {focusElement ? (
              <ArchitectureElementFocusView
                element={focusElement}
                architecture={architecture}
                statusByElementId={statusByElementId}
                allocatedRequirements={focusElementRequirements}
                conflicts={focusElementConflicts}
                onBack={handleBackToArchitecture}
                onSelectInterface={handleFocusSelectInterface}
                onSelectRequirement={handleFocusSelectRequirement}
                onSave={handleSaveElement}
                onDelete={handleDeleteElement}
                onToggleDynamicDesign={handleToggleDynamicDesign}
                onRemoveInterface={handleRemoveInterface}
                onCheckInterfaceConflict={handleCheckInterfaceConflict}
                onAskArchitectAboutInterface={handleAskArchitectAboutInterface}
              />
            ) : (
              <ArchitectureGrid
                architecture={architecture}
                statusByElementId={statusByElementId}
                conflictedElementIds={conflictedElementIds}
                requirementCountByElementId={requirementCountByElementId}
                statusFilter={statusFilter}
                selectedElementId={selectedElementId}
                dropTargetElementId={dropTargetElementId}
                onSelectElement={handleSelectElement}
                onDropRequirement={handleDropRequirements}
                onDropTargetChange={setDropTargetElementId}
              />
            )}
          </div>
        </div>
      )}

      {interfaceConflictResult !== undefined && (
        <div className="modal-overlay" onClick={() => setInterfaceConflictResult(undefined)}>
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <div className="requirement-detail-header">
              <span className="requirement-detail-id">Interface check</span>
              <button
                type="button"
                className="requirement-detail-edit-btn"
                onClick={() => setInterfaceConflictResult(undefined)}
              >
                Close
              </button>
            </div>
            {interfaceConflictResult === null ? (
              <p className="requirements-check-empty">No conflict found for this interface.</p>
            ) : (
              <div className="analyst-chat-proposal">
                <strong>{interfaceConflictResult.kind}</strong>
                <p>{interfaceConflictResult.rationale}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {interfacesCheckResult && (
        <div className="modal-overlay" onClick={() => setInterfacesCheckResult(null)}>
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <div className="requirement-detail-header">
              <span className="requirement-detail-id">Interfaces check</span>
              <button
                type="button"
                className="requirement-detail-edit-btn"
                onClick={() => setInterfacesCheckResult(null)}
              >
                Close
              </button>
            </div>
            {interfacesCheckResult.complete ? (
              <p className="requirements-check-empty">Every connected interface has a defined contract.</p>
            ) : (
              <>
                {interfacesCheckResult.undefinedPairs.length > 0 && (
                  <div className="analyst-chat-proposal">
                    <strong>Undefined ({interfacesCheckResult.undefinedPairs.length})</strong>
                    <ul className="quality-score-deductions">
                      {interfacesCheckResult.undefinedPairs.map((p) => {
                        const from = architecture?.elements.find((e) => e.id === p.fromId)
                        const to = architecture?.elements.find((e) => e.id === p.toId)
                        return (
                          <li key={`${p.fromId}-${p.toId}`} className="quality-score-conflict-value">
                            {from?.name ?? p.fromId} ↔ {to?.name ?? p.toId}
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                )}
                {interfacesCheckResult.staleContracts.length > 0 && (
                  <div className="analyst-chat-proposal">
                    <strong>Stale ({interfacesCheckResult.staleContracts.length})</strong>
                    <ul className="quality-score-deductions">
                      {interfacesCheckResult.staleContracts.map((c) => {
                        const from = architecture?.elements.find((e) => e.id === c.fromId)
                        const to = architecture?.elements.find((e) => e.id === c.toId)
                        return (
                          <li key={`${c.fromId}-${c.toId}`} className="quality-score-conflict-value">
                            {from?.name ?? c.fromId} ↔ {to?.name ?? c.toId}
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {codeAlignmentCheckResult && (
        <div className="modal-overlay" onClick={() => setCodeAlignmentCheckResult(null)}>
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <div className="requirement-detail-header">
              <span className="requirement-detail-id">Interface/Code alignment check</span>
              <button
                type="button"
                className="requirement-detail-edit-btn"
                onClick={() => setCodeAlignmentCheckResult(null)}
              >
                Close
              </button>
            </div>
            {codeAlignmentCheckResult.aligned ? (
              <p className="requirements-check-empty">
                Every defined interface contract's operations match the generated source.
              </p>
            ) : (
              <>
                {codeAlignmentCheckResult.unimplementedOperations.length > 0 && (
                  <div className="analyst-chat-proposal">
                    <strong>
                      Defined but not implemented ({codeAlignmentCheckResult.unimplementedOperations.length})
                    </strong>
                    <ul className="quality-score-deductions">
                      {codeAlignmentCheckResult.unimplementedOperations.map((op, i) => {
                        const from = architecture?.elements.find((e) => e.id === op.fromId)
                        const to = architecture?.elements.find((e) => e.id === op.toId)
                        return (
                          <li key={`${op.fromId}-${op.toId}-${op.operationName}-${i}`} className="quality-score-conflict-value">
                            {op.operationName} — {from?.name ?? op.fromId} ↔ {to?.name ?? op.toId}
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                )}
                {codeAlignmentCheckResult.undocumentedIdentifiers.length > 0 && (
                  <div className="analyst-chat-proposal">
                    <strong>
                      Implemented but not in Architecture ({codeAlignmentCheckResult.undocumentedIdentifiers.length})
                    </strong>
                    <ul className="quality-score-deductions">
                      {codeAlignmentCheckResult.undocumentedIdentifiers.map((op, i) => {
                        const from = architecture?.elements.find((e) => e.id === op.fromId)
                        const to = architecture?.elements.find((e) => e.id === op.toId)
                        return (
                          <li key={`${op.fromId}-${op.toId}-${op.operationName}-${i}`} className="quality-score-conflict-value">
                            {op.operationName} — {from?.name ?? op.fromId} ↔ {to?.name ?? op.toId}
                          </li>
                        )
                      })}
                    </ul>
                    <p className="requirements-check-empty">
                      This is a best-effort text scan, not a compiler — a match here means a declared function/method
                      whose name doesn't correspond to any contract operation. Review before deciding whether the
                      Architecture needs updating or the code does.
                    </p>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {addFormOpen && architecture && (
        <AddArchitectureElementForm
          layers={architecture.layers}
          onAdd={handleAddElement}
          onClose={() => setAddFormOpen(false)}
        />
      )}

      {alignmentPanelOpen && codeAlignment && (
        <div className="modal-overlay" onClick={() => setAlignmentPanelOpen(false)}>
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <div className="requirement-detail-header">
              <span className="requirement-detail-id">Code alignment — unmapped files</span>
              <button
                type="button"
                className="requirement-detail-edit-btn"
                onClick={() => setAlignmentPanelOpen(false)}
              >
                Close
              </button>
            </div>
            {unmappedFiles.length === 0 ? (
              <p className="requirements-check-empty">Every file mapped to an architecture element.</p>
            ) : (
              unmappedFiles.map((mapping) => (
                <div key={mapping.filePath} className="analyst-chat-proposal">
                  <span className="req-id-highlight">{mapping.filePath}</span>
                  <p>{mapping.rationale}</p>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
