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
  InterfaceContractOperation,
  PlatformDescriptor,
  PlatformId,
  PhaseInfo,
  ProjectMode,
  ProposedArchitectureElement,
  ProposedInterface,
  Requirement,
  Status,
  VicCoreApi,
  ChatMessageLink,
} from '../api/types'
import { STATUS_COLOR, STATUS_LABEL } from '../statusColor'
import { toOperationError } from '../api/errorCode'
import { highlightRequirementIds } from './requirementIdHighlight'
import { ChatDock } from '../components/ChatDock'
import type { PendingChatNav } from '../navigation/chatLinkNav'
import { ArchitectureGrid } from './ArchitectureGrid'
import { ArchitectureElementFocusView } from './ArchitectureElementFocusView'
import { ArchitectureRequirementList } from './ArchitectureRequirementList'
import { AddArchitectureElementForm } from './AddArchitectureElementForm'
import { EditableElementProposalCard } from './EditableElementProposalCard'
import { MigrationPlanPanel } from './MigrationPlanPanel'
import { InterfaceListPanel } from './InterfaceListPanel'
import { InterfaceEditorModal } from './InterfaceEditorModal'
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
  onChatNavigate: (link: ChatMessageLink) => void
  pendingChatNav: PendingChatNav | null
  onChatNavConsumed: () => void
}

const STATUS_FILTERS: Status[] = ['not-started', 'in-progress', 'blocked', 'complete']

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
  onChatNavigate,
  pendingChatNav,
  onChatNavConsumed,
}: ArchitectureScreenProps) {
  const [types, setTypes] = useState<ArchitectureTypeOption[]>([])
  const [selectedType, setSelectedType] = useState<ArchitectureTypeId | null>(null)
  // Project platform (project harness feature)
  const [platforms, setPlatforms] = useState<PlatformDescriptor[]>([])
  const [selectedPlatform, setSelectedPlatform] = useState<PlatformId | null>(null)
  const [addPlatformOpen, setAddPlatformOpen] = useState(false)
  // Whether the platform card grid is showing. Once a platform is picked the
  // grid collapses to a single "Platform: X · Change" line (same pattern as
  // Architecture type); "Change" re-opens it.
  const [platformPickerOpen, setPlatformPickerOpen] = useState(false)
  const [newPlatform, setNewPlatform] = useState({ label: '', entryPointHint: '', wiringHint: '', lifecycleHint: '' })
  const [pendingPlatformChange, setPendingPlatformChange] = useState<string | null>(null)
  const [definingHarness, setDefiningHarness] = useState(false)
  const [architecture, setArchitecture] = useState<Architecture | null>(null)
  const [requirements, setRequirements] = useState<Requirement[]>([])
  const [loading, setLoading] = useState(true)

  // Project Overview panel — what the app is, what tech it's built with,
  // and how to build/run it. Not tied to any one architecture element (an
  // entrypoint conceptually spans all of them); read into every Coding-
  // stage prompt as extra context and available to Test Full App.
  const [overviewDescription, setOverviewDescription] = useState('')
  const [overviewRunInstructions, setOverviewRunInstructions] = useState('')
  // Collapsed by default once it has content (the user has already filled it
  // in — no reason to keep two big textareas open on every visit); starts
  // open only while still empty so a first-time user sees the prompt. Set
  // once, when the overview first loads — a later edit that empties both
  // fields shouldn't yank the panel open under the user's cursor.
  const [overviewOpen, setOverviewOpen] = useState(true)
  const [overviewLoaded, setOverviewLoaded] = useState(false)
  const [autoPopulatingOverview, setAutoPopulatingOverview] = useState(false)

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
  const [redefiningInterfaces, setRedefiningInterfaces] = useState(false)
  const [interfaceListOpen, setInterfaceListOpen] = useState(false)
  // Either an existing definition (opened from InterfaceListPanel's
  // grouped rows) or a still-uncovered pair with no definition yet (opened
  // from a "Define this interface" action, or an undefined-pair row) —
  // exactly one is set at a time. The editor modal resolves whichever is
  // present into its participant list/operations.
  const [editingInterfaceDefinitionId, setEditingInterfaceDefinitionId] = useState<string | null>(null)
  const [editingInterfacePair, setEditingInterfacePair] = useState<{ fromId: string; toId: string } | null>(null)
  const [checkingInterfaces, setCheckingInterfaces] = useState(false)
  const [interfacesCheckResult, setInterfacesCheckResult] = useState<CheckInterfacesResult | null>(null)
  const [checkingCodeAlignment, setCheckingCodeAlignment] = useState(false)
  const [codeAlignmentCheckResult, setCodeAlignmentCheckResult] = useState<CheckInterfaceCodeAlignmentResult | null>(
    null,
  )

  // Architect-chat proposal cards still live here (surface-specific side
  // content under the shared ChatDock's transcript).
  const [proposedElements, setProposedElements] = useState<ProposedArchitectureElement[]>([])
  const [proposedInterfaces, setProposedInterfaces] = useState<ProposedInterface[]>([])

  // Whether this project actually has imported legacy source on disk — the
  // Migration Plan panel is only meaningful then, not for every import-mode
  // project (an import project whose sources were never uploaded, or a
  // greenfield one, has nothing to migrate). Checked via the source tree.
  const [hasLegacyCode, setHasLegacyCode] = useState(false)
  // Per-section collapse state for the left column, so a squeezed
  // Requirements list can be given room by folding the panels around it.
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({})
  const toggleSection = (key: string) =>
    setCollapsedSections((prev) => ({ ...prev, [key]: !prev[key] }))
  const isCollapsed = (key: string, defaultCollapsed = false) =>
    collapsedSections[key] ?? defaultCollapsed

  useEffect(() => {
    let cancelled = false
    api
      .getSourceTree(projectId)
      .then((tree) => {
        if (!cancelled) setHasLegacyCode((tree.files?.length ?? 0) > 0)
      })
      .catch(() => {
        if (!cancelled) setHasLegacyCode(false)
      })
    return () => {
      cancelled = true
    }
  }, [api, projectId])
  // Bumped to push prefilled composer text into the ChatDock (see
  // handleAskArchitectAboutInterface).
  const [chatPrefill, setChatPrefill] = useState<{ text: string; nonce: number }>({ text: '', nonce: 0 })

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
    Promise.all([
      api.listArchitectureTypes(),
      api.getArchitectureType(projectId),
      api.listPlatforms(),
      api.getProjectPlatform(projectId),
    ]).then(async ([typeOptions, current, platformOptions, currentPlatform]) => {
      if (cancelled) return
      setTypes(typeOptions)
      setSelectedType(current)
      setPlatforms(platformOptions)
      setSelectedPlatform(currentPlatform)
      if (current) await loadArchitecture()
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [api, projectId, loadArchitecture])

  useEffect(() => {
    let cancelled = false
    api.getProjectOverview(projectId).then(({ description, runInstructions }) => {
      if (cancelled) return
      setOverviewDescription(description)
      setOverviewRunInstructions(runInstructions)
      setOverviewOpen(!(description.trim() || runInstructions.trim()))
      setOverviewLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [api, projectId])

  async function handleSaveOverview() {
    await api.setProjectOverview(projectId, overviewDescription, overviewRunInstructions)
  }

  async function handleAutoPopulateOverview() {
    if (autoPopulatingOverview) return
    setAutoPopulatingOverview(true)
    try {
      const result = await api.autoPopulateProjectOverview(projectId)
      setOverviewDescription(result.description)
      setOverviewRunInstructions(result.runInstructions)
      await api.setProjectOverview(projectId, result.description, result.runInstructions)
    } catch (err) {
      onOperationChange(toOperationError(err))
    } finally {
      setAutoPopulatingOverview(false)
    }
  }

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

  // Project platform (project harness feature) ------------------------------

  async function handleSelectPlatform(platformId: string) {
    if (selectedPlatform && selectedPlatform !== platformId) {
      // Changing an already-set platform re-derives the harness and
      // invalidates generated code — confirm and offer to branch first.
      setPendingPlatformChange(platformId)
      return
    }
    setSelectedPlatform(platformId)
    setPlatformPickerOpen(false)
    try {
      const result = await api.setProjectPlatform(projectId, platformId)
      // T2.1: the server auto-derives the harness spec on platform-set. Tell
      // the user if that failed so they know to use the manual button.
      if (result.harnessSpecError) {
        onOperationChange({
          text: null,
          error: `Platform saved, but deriving the Harness failed: ${result.harnessSpecError}. Use "Define Harness" to retry.`,
        })
      }
      await loadArchitecture()
    } catch (err) {
      onOperationChange(toOperationError(err))
    }
  }

  async function handleConfirmChangeInPlace() {
    const platformId = pendingPlatformChange
    if (!platformId) return
    setPendingPlatformChange(null)
    setSelectedPlatform(platformId)
    setPlatformPickerOpen(false)
    try {
      await api.setProjectPlatform(projectId, platformId)
      await api.defineHarness(projectId)
      await loadArchitecture()
    } catch (err) {
      onOperationChange(toOperationError(err))
    }
  }

  async function handleBranchPlatform() {
    const platformId = pendingPlatformChange
    if (!platformId) return
    setPendingPlatformChange(null)
    try {
      const { newProject } = await api.branchProjectPlatform(projectId, platformId)
      onOperationChange({
        text: `Branched to "${newProject.name}". The original project has been renamed with its previous platform.`,
      })
    } catch (err) {
      onOperationChange(toOperationError(err))
    }
  }

  async function handleAddCustomPlatform() {
    try {
      const created = await api.addCustomPlatform(newPlatform)
      setPlatforms((prev) => [...prev, created])
      setAddPlatformOpen(false)
      setNewPlatform({ label: '', entryPointHint: '', wiringHint: '', lifecycleHint: '' })
    } catch (err) {
      onOperationChange(toOperationError(err))
    }
  }

  async function handleDeleteCustomPlatform(platformId: string) {
    try {
      await api.deleteCustomPlatform(platformId)
      setPlatforms((prev) => prev.filter((p) => p.id !== platformId))
    } catch (err) {
      onOperationChange(toOperationError(err))
    }
  }

  async function handleDefineHarness() {
    if (definingHarness) return
    setDefiningHarness(true)
    try {
      await api.defineHarness(projectId)
      await loadArchitecture()
    } catch (err) {
      onOperationChange(toOperationError(err))
    } finally {
      setDefiningHarness(false)
    }
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
      await api.defineAllArchitectureInterfaceDefinitions(projectId)
      await loadArchitecture()
      onOperationChange({ text: null })
    } catch (err) {
      onOperationChange(toOperationError(err))
    } finally {
      setDefiningInterfaces(false)
    }
  }

  // Unlike "Define Interfaces" (non-destructive, only fills pairs with no
  // contract at all), this re-asks the Architect for EVERY connected pair,
  // overwriting whatever contract already exists — the bulk equivalent of
  // the per-interface "Redefine" action, needed e.g. to backfill new
  // contract fields (range/resolution/unit/update-frequency) onto contracts
  // that were defined before those fields existed.
  async function handleRedefineAllInterfaces() {
    if (redefiningInterfaces) return
    if (!window.confirm('Redefine every connected interface? This overwrites all existing interface contracts.')) return
    setRedefiningInterfaces(true)
    onOperationChange({ text: 'Architect is redefining all interfaces...' })
    try {
      await api.defineAllArchitectureInterfaceDefinitions(projectId, true)
      await loadArchitecture()
      onOperationChange({ text: null })
    } catch (err) {
      onOperationChange(toOperationError(err))
    } finally {
      setRedefiningInterfaces(false)
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

  // The Interfaces list needs an up-to-date check result to know which rows
  // are undefined/incomplete/stale (red) vs. fully defined (not red) — run
  // it fresh every time the list opens rather than relying on whatever
  // interfacesCheckResult happens to already hold (possibly null, or stale
  // from before the user's last edit).
  async function handleOpenInterfaceList() {
    setInterfaceListOpen(true)
    try {
      const result = await api.checkArchitectureInterfaces(projectId)
      setInterfacesCheckResult(result)
    } catch (err) {
      onOperationChange(toOperationError(err))
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
    // Auto Configure never deletes or overwrites an existing element — it
    // adds modules for still-unallocated requirements and allocates onto
    // the combined set. When real modules already exist, warn so the user
    // knows they'll get a mixed (LLM-proposed + existing) architecture
    // rather than a clean-slate one.
    if (
      hasNonHarnessElements &&
      !window.confirm(
        'This architecture already has modules. Auto Configure will keep them, add new modules for any still-unallocated requirements, connect interfaces, and allocate — it will not delete or overwrite what is already there. Continue?',
      )
    ) {
      return
    }
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

  async function handleAutoAllocate(mode: 'llm') {
    if (autoAllocating) return
    setAutoAllocating(true)
    onOperationChange({ text: 'Architect is allocating requirements...' })
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

  const sendArchitectChat = useCallback(
    async (sessionId: string, message: string) => {
      onOperationChange({ text: 'Architect is thinking...' })
      try {
        const result = await api.architectChat(projectId, message, sessionId)
        setProposedElements((prev) => [...prev, ...result.proposedElements])
        setProposedInterfaces((prev) => [...prev, ...result.proposedInterfaces])
        onOperationChange({ text: null })
        return { userMessage: result.userMessage, assistantMessage: result.assistantMessage }
      } catch (err) {
        onOperationChange(toOperationError(err))
        throw err
      }
    },
    [api, projectId, onOperationChange],
  )

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


  async function handleRemoveInterface(fromId: string, toId: string) {
    const from = architecture?.elements.find((e) => e.id === fromId)
    const to = architecture?.elements.find((e) => e.id === toId)
    const label = `${from?.name ?? fromId} → ${to?.name ?? toId}`
    if (!window.confirm(`Remove the interface "${label}"? This cannot be undone.`)) return
    await api.removeArchitectureInterface(projectId, fromId, toId)
    await loadArchitecture()
  }

  // Redefines (overwrites) a single already-'defined' contract — unlike the
  // bulk "Define Interfaces" action (non-destructive, only fills pairs with
  // no contract at all), this always re-asks the Architect, which is the
  // only way to backfill the range/resolution/unit/update-frequency fields
  // onto a contract that was defined before those fields existed.
  async function handleDefineInterface(fromId: string, toId: string) {
    const from = architecture?.elements.find((e) => e.id === fromId)
    const to = architecture?.elements.find((e) => e.id === toId)
    onOperationChange({ text: `Architect is defining the interface between ${from?.name ?? fromId} and ${to?.name ?? toId}...` })
    try {
      await api.defineArchitectureInterfaceDefinition(projectId, fromId, toId)
      await loadArchitecture()
      onOperationChange({ text: null })
    } catch (err) {
      onOperationChange(toOperationError(err))
    }
  }

  // Manual counterpart to Define/Redefine — saves a user-authored operation
  // list directly, no LLM call. Backs the InterfaceEditorModal opened from
  // either the global Interfaces list or an element's own focus view.
  // definitionId is undefined when editing a still-uncovered pair (creates
  // a new 2-participant definition); participants/name are resolved by the
  // caller from either the existing definition or the pair being edited.
  async function handleSaveInterfaceDefinition(
    definitionId: string | undefined,
    name: string,
    participants: Array<{ elementId: string; role: 'produces' | 'consumes' | 'both' }>,
    operations: InterfaceContractOperation[],
  ) {
    await api.setArchitectureInterfaceDefinition(projectId, definitionId, name, participants, operations)
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
    setChatPrefill((prev) => ({
      text: `Review the interface between ${from?.name ?? fromId} and ${to?.name ?? toId}.`,
      nonce: prev.nonce + 1,
    }))
  }

  // Consume a chat link chip that targeted an architecture element.
  useEffect(() => {
    if (!pendingChatNav || pendingChatNav.kind !== 'element') return
    setSelectedElementId(pendingChatNav.id)
    onChatNavConsumed()
  }, [pendingChatNav, onChatNavConsumed])

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
  // The Harness is a composition root with no requirements of its own —
  // Auto Configure/Allocate already ignore it server-side
  // (allocatableElements filters kind:'harness'), so it must not gate the
  // buttons either. This is the count that actually matters for "does the
  // architecture already have real modules".
  const hasNonHarnessElements =
    (architecture?.elements.filter((e) => e.kind !== 'harness').length ?? 0) > 0

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
  // Harness spec state (project harness feature). Three cases, and the UI
  // must warn about ALL of them — the never-derived case used to show
  // nothing because harnessOutOfDate required a spec to exist.
  const harnessSpec = architecture?.elements.find((e) => e.kind === 'harness')?.harnessSpec
  const nonHarnessElementCount = (architecture?.elements ?? []).filter((e) => e.kind !== 'harness').length
  const harnessMissing = !!selectedPlatform && nonHarnessElementCount > 0 && !harnessSpec
  const harnessOutOfDate =
    !!selectedPlatform && !!harnessSpec && harnessSpec.derivedForPlatform !== selectedPlatform
  const harnessNeedsAttention = harnessMissing || harnessOutOfDate
  const harnessAttentionLabel = harnessMissing
    ? 'Harness not defined — Coding the Harness will be refused until you run Define Harness'
    : 'Harness out of date — it was derived for a different platform; run Define Harness again'
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

      <section className="architecture-overview-panel">
        <div className="architecture-overview-header-row">
          <button
            type="button"
            className="architecture-overview-toggle"
            onClick={() => setOverviewOpen((open) => !open)}
          >
            {overviewOpen ? '▾' : '▸'} Project Overview
          </button>
          {!overviewOpen && overviewLoaded && (selectedOption || selectedPlatform) && (
            <div className="architecture-overview-header-meta">
              {selectedOption && (
                <span>
                  Architecture type: <strong>{selectedOption.label}</strong>
                </span>
              )}
              {selectedPlatform && (
                <span>
                  Platform:{' '}
                  <strong>{platforms.find((p) => p.id === selectedPlatform)?.label ?? selectedPlatform}</strong>
                </span>
              )}
            </div>
          )}
        </div>
        {overviewOpen && (
          <div className="architecture-overview-body">
            <button
              type="button"
              className="architecture-action-secondary architecture-overview-auto-populate"
              onClick={handleAutoPopulateOverview}
              disabled={autoPopulatingOverview}
              title="Has the Architect draft both fields below from the project's requirements and architecture — overwrites whatever is currently there."
            >
              {autoPopulatingOverview ? 'Auto Populating...' : 'Auto Populate'}
            </button>
            <label className="architecture-overview-label">
              What this app is, and the tech it's built with
              <textarea
                value={overviewDescription}
                onChange={(e) => setOverviewDescription(e.target.value)}
                onBlur={handleSaveOverview}
                placeholder="e.g. A React + Node/Express task tracker, using SQLite for storage..."
                rows={3}
              />
            </label>
            <label className="architecture-overview-label">
              How to build and run it
              <textarea
                value={overviewRunInstructions}
                onChange={(e) => setOverviewRunInstructions(e.target.value)}
                onBlur={handleSaveOverview}
                placeholder="e.g. npm install && npm run dev, starts on http://localhost:3000..."
                rows={3}
              />
            </label>
          </div>
        )}
      </section>

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
              The app's internal <em>structure</em> — how its parts are organised (layered,
              hexagonal, event-driven…). Not the same as Platform below, which is where the built
              app runs. This sets the default grid layout (layer rows) and dynamic-design
              behaviour — both can still be adjusted afterward.
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

      {selectedOption && (
        <section className="architecture-type-selector architecture-platform-selector">
          {selectedPlatform && !platformPickerOpen ? (
            <p className="architecture-type-line">
              Platform: <strong>{platforms.find((p) => p.id === selectedPlatform)?.label ?? selectedPlatform}</strong>
              {' · '}
              <button
                type="button"
                className="architecture-type-change-link"
                onClick={() => setPlatformPickerOpen(true)}
              >
                Change
              </button>
              {' · '}
              <button
                type="button"
                className="architecture-type-change-link"
                onClick={handleDefineHarness}
                disabled={definingHarness}
              >
                {definingHarness ? 'Defining Harness…' : 'Define Harness'}
              </button>
              {harnessNeedsAttention && (
                <span className="architecture-type-line-warning"> · {harnessAttentionLabel}</span>
              )}
            </p>
          ) : (
            <>
          <h2>Platform</h2>
          <p className="architecture-type-hint">
            The single deployment/runtime <em>target</em> — where the built app actually runs (browser, CLI,
            Electron, microcontroller…). Distinct from Architecture type above, which is the app's internal
            structure. Platform determines how the Harness realises the entry point, element wiring and run
            lifecycle; changing it later re-derives the Harness and invalidates generated code.
          </p>
          {harnessNeedsAttention && (
            <p className="architecture-type-line-warning">
              {harnessAttentionLabel}.{' '}
              <button
                type="button"
                className="architecture-type-change-link"
                onClick={handleDefineHarness}
                disabled={definingHarness}
              >
                {definingHarness ? 'Defining Harness…' : 'Define Harness now'}
              </button>
            </p>
          )}
          <div className="architecture-type-grid">
            {platforms.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`architecture-type-card ${selectedPlatform === p.id ? 'selected' : ''}`}
                onClick={() => handleSelectPlatform(p.id)}
              >
                <span className="architecture-type-card-label">
                  {p.label}
                  {!p.builtIn && (
                    <span
                      className="architecture-platform-delete"
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation()
                        void handleDeleteCustomPlatform(p.id)
                      }}
                    >
                      ×
                    </span>
                  )}
                </span>
                <span className="architecture-type-card-description">{p.entryPointHint}</span>
              </button>
            ))}
            <button
              type="button"
              className="architecture-type-card"
              onClick={() => setAddPlatformOpen(true)}
            >
              <span className="architecture-type-card-label">+ Add custom platform</span>
              <span className="architecture-type-card-description">
                Persists for future projects; you can delete it later.
              </span>
            </button>
          </div>
            </>
          )}
        </section>
      )}

      {addPlatformOpen && (
        <div className="modal-overlay" onClick={() => setAddPlatformOpen(false)}>
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <h3>Add custom platform</h3>
            {(['label', 'entryPointHint', 'wiringHint', 'lifecycleHint'] as const).map((field) => (
              <label key={field} className="architecture-field-label">
                {field === 'label'
                  ? 'Name'
                  : field === 'entryPointHint'
                    ? 'Entry point (how "run this" looks)'
                    : field === 'wiringHint'
                      ? 'Wiring (how elements are connected)'
                      : 'Run lifecycle (start / stop)'}
                <input
                  type="text"
                  value={newPlatform[field]}
                  onChange={(e) => setNewPlatform((prev) => ({ ...prev, [field]: e.target.value }))}
                />
              </label>
            ))}
            <div className="modal-actions">
              <button type="button" onClick={() => setAddPlatformOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                onClick={handleAddCustomPlatform}
                disabled={Object.values(newPlatform).some((v) => !v.trim())}
              >
                Add
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingPlatformChange && (
        <div className="modal-overlay" onClick={() => setPendingPlatformChange(null)}>
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <h3>Change platform?</h3>
            <p>
              Changing the platform re-derives the Harness from scratch. Every "how each link is
              realised" note changes, and all generated code, coding-run history and test results for
              this project become invalid and must be regenerated.
            </p>
            <div className="modal-actions">
              <button type="button" onClick={() => setPendingPlatformChange(null)}>
                Cancel
              </button>
              <button type="button" onClick={handleConfirmChangeInPlace}>
                Change in place
              </button>
              <button type="button" onClick={handleBranchPlatform}>
                Branch to a new project
              </button>
            </div>
          </div>
        </div>
      )}

      {!loading && !selectedOption && !unknownSelectedType && (
        <p className="architecture-screen-note">Select an architecture type above to continue.</p>
      )}

      {showArchitectureWorkspace && (
        <div className="architecture-layout" ref={layoutRef}>
          <div className="architecture-left-col" style={{ flexBasis: `${splitFraction * 100}%` }}>
            <div className={`architecture-action-box${isCollapsed('actions') ? ' architecture-section-collapsed' : ''}`}>
              <button
                type="button"
                className="architecture-section-toggle"
                onClick={() => toggleSection('actions')}
                aria-expanded={!isCollapsed('actions')}
              >
                <span className="architecture-section-toggle-caret">{isCollapsed('actions') ? '▸' : '▾'}</span>
                Actions
              </button>
              {!isCollapsed('actions') && (
              <>
              <div className="architecture-action-bar">
                <div className="architecture-action-group">
                  <span className="architecture-action-group-label">Build</span>
                  <div className="architecture-action-group-buttons">
                    <button type="button" onClick={() => setAddFormOpen(true)}>
                      Add element
                    </button>
                    <button
                      type="button"
                      className="architecture-action-secondary"
                      onClick={handleAutoConfigureAndAllocate}
                      disabled={autoConfiguring}
                      title={
                        hasNonHarnessElements
                          ? 'Modules already exist. Auto Configure keeps them, adds modules for any still-unallocated requirements, connects interfaces, and allocates — it never deletes or overwrites existing modules. You will be asked to confirm.'
                          : 'Groups unallocated requirements into modules, creates the architecture elements, connects their interfaces, and allocates the requirements.'
                      }
                    >
                      {autoConfiguring ? 'Auto Configuring...' : 'Auto Configure & Allocate'}
                    </button>
                    <button
                      type="button"
                      className="architecture-action-secondary"
                      onClick={() => handleAutoAllocate('llm')}
                      disabled={autoAllocating || !hasNonHarnessElements}
                      title={
                        hasNonHarnessElements
                          ? 'Allocates unallocated requirements onto existing elements using the Architect (LLM).'
                          : 'Add at least one non-Harness architecture element first (the Harness has no requirements of its own).'
                      }
                    >
                      {autoAllocating ? 'Allocating...' : 'Auto Allocate (LLM)'}
                    </button>
                  </div>
                </div>

                <div className="architecture-action-group">
                  <span className="architecture-action-group-label">Interfaces</span>
                  <div className="architecture-action-group-buttons">
                    <button
                      type="button"
                      className="architecture-action-secondary"
                      onClick={handleDefineInterfaces}
                      disabled={definingInterfaces || !hasElements}
                      title="Has the Architect define a structured contract (operations, request/response shape) for every connected pair that doesn't have one yet. Leaves already-defined contracts untouched."
                    >
                      {definingInterfaces ? 'Defining Interfaces...' : 'Define Interfaces'}
                    </button>
                    <button
                      type="button"
                      className="architecture-action-secondary"
                      onClick={handleRedefineAllInterfaces}
                      disabled={redefiningInterfaces || !hasElements}
                      title="Re-asks the Architect for EVERY connected interface, overwriting all existing contracts. Use this to backfill fields added after a contract was already defined."
                    >
                      {redefiningInterfaces ? 'Redefining All...' : 'Redefine All Interfaces'}
                    </button>
                    <button
                      type="button"
                      className="architecture-action-secondary"
                      onClick={handleOpenInterfaceList}
                      disabled={!hasElements}
                      title="Lists every connected interface (defined, undefined, or incomplete) — click any to edit its operations manually, no LLM call."
                    >
                      Interface Inspector
                    </button>
                  </div>
                </div>

                <div className="architecture-action-group">
                  <span className="architecture-action-group-label">Check</span>
                  <div className="architecture-action-group-buttons">
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
                </div>
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
              </>
              )}
            </div>

            <div
              className={`architecture-req-list-panel${
                isCollapsed('requirements') ? ' architecture-section-collapsed' : ''
              }`}
            >
              <h2 className="architecture-req-list-heading">
                <button
                  type="button"
                  className="architecture-section-toggle"
                  onClick={() => toggleSection('requirements')}
                  aria-expanded={!isCollapsed('requirements')}
                >
                  <span className="architecture-section-toggle-caret">
                    {isCollapsed('requirements') ? '▸' : '▾'}
                  </span>
                  Requirements{requirements.length > 0 ? ` (${requirements.length})` : ''}
                </button>
                {unallocatedRequirementCount > 0 && (
                  <span className="architecture-req-list-unallocated-count">
                    {' '}
                    — {unallocatedRequirementCount} unallocated
                  </span>
                )}
              </h2>
              {!isCollapsed('requirements') && (
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
              )}
            </div>

            {/* Migration Plan is only meaningful when there is imported
                legacy source to migrate — not for every import-mode project
                (one whose sources were never uploaded has nothing to plan). */}
            {projectMode === 'import' && hasLegacyCode && (
              <div
                className={`architecture-migration-plan-panel${
                  isCollapsed('migration', true) ? ' architecture-section-collapsed' : ''
                }`}
              >
                <button
                  type="button"
                  className="architecture-section-toggle"
                  onClick={() => toggleSection('migration')}
                  aria-expanded={!isCollapsed('migration', true)}
                >
                  <span className="architecture-section-toggle-caret">
                    {isCollapsed('migration', true) ? '▸' : '▾'}
                  </span>
                  Migration Plan
                </button>
                {!isCollapsed('migration', true) && (
                  <MigrationPlanPanel api={api} projectId={projectId} onOperationChange={onOperationChange} />
                )}
              </div>
            )}

            <ChatDock
              api={api}
              projectId={projectId}
              surface="architect"
              roleLabel="Architect"
              heading="Architect chat"
              hint="Ask the Architect to help design, extend, or refine the architecture."
              placeholder="Message the Architect... (Shift+Enter for a new line)"
              onOpenSettings={onOpenSettings}
              onNavigateLink={onChatNavigate}
              renderMessageText={highlightRequirementIds}
              sendMessage={sendArchitectChat}
              prefill={chatPrefill.nonce > 0 ? chatPrefill : undefined}
              renderExtras={() => (
                <>
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
                </>
              )}
            />
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
                onDefineInterface={handleDefineInterface}
                onEditInterface={(fromId, toId) => {
                  setEditingInterfaceDefinitionId(null)
                  setEditingInterfacePair({ fromId, toId })
                }}
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
                          <li key={`${p.fromId}-${p.toId}`}>
                            <button
                              type="button"
                              className="interface-check-clickable-row"
                              onClick={() => {
                                setInterfacesCheckResult(null)
                                setEditingInterfaceDefinitionId(null)
                                setEditingInterfacePair({ fromId: p.fromId, toId: p.toId })
                              }}
                            >
                              {from?.name ?? p.fromId} ↔ {to?.name ?? p.toId}
                            </button>
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
                      {interfacesCheckResult.staleContracts.map((d) => (
                        <li key={d.id}>
                          <button
                            type="button"
                            className="interface-check-clickable-row"
                            onClick={() => {
                              setInterfacesCheckResult(null)
                              setEditingInterfacePair(null)
                              setEditingInterfaceDefinitionId(d.id)
                            }}
                          >
                            {d.name}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {interfacesCheckResult.incompleteOperations.length > 0 && (
                  <div className="analyst-chat-proposal">
                    <strong>Missing I/O detail ({interfacesCheckResult.incompleteOperations.length})</strong>
                    <ul className="quality-score-deductions">
                      {interfacesCheckResult.incompleteOperations.map((o) => {
                        const from = architecture?.elements.find((e) => e.id === o.fromId)
                        const to = architecture?.elements.find((e) => e.id === o.toId)
                        return (
                          <li key={`${o.fromId}-${o.toId}-${o.operationName}`}>
                            <button
                              type="button"
                              className="interface-check-clickable-row"
                              onClick={() => {
                                setInterfacesCheckResult(null)
                                setEditingInterfaceDefinitionId(null)
                                setEditingInterfacePair({ fromId: o.fromId, toId: o.toId })
                              }}
                            >
                              {from?.name ?? o.fromId} ↔ {to?.name ?? o.toId} — <strong>{o.operationName}</strong>:
                              missing {o.missingFields.join(', ')}
                            </button>
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

      {interfaceListOpen && architecture && (
        <InterfaceListPanel
          architecture={architecture}
          checkResult={interfacesCheckResult}
          onSelectDefinition={(definitionId) => {
            setInterfaceListOpen(false)
            setEditingInterfacePair(null)
            setEditingInterfaceDefinitionId(definitionId)
          }}
          onSelectPair={(fromId, toId) => {
            setInterfaceListOpen(false)
            setEditingInterfaceDefinitionId(null)
            setEditingInterfacePair({ fromId, toId })
          }}
          onClose={() => setInterfaceListOpen(false)}
        />
      )}

      {editingInterfaceDefinitionId &&
        architecture &&
        (() => {
          const definition = (architecture.interfaceDefinitions ?? []).find((d) => d.id === editingInterfaceDefinitionId)
          if (!definition) return null
          const participantLabels = definition.participants.map((p) => {
            const element = architecture.elements.find((e) => e.id === p.elementId)
            return `${element?.name ?? p.elementId} (${p.role})`
          })
          return (
            <InterfaceEditorModal
              participantLabels={participantLabels}
              operations={definition.operations}
              onSave={(operations) =>
                handleSaveInterfaceDefinition(definition.id, definition.name, definition.participants, operations)
              }
              onClose={() => setEditingInterfaceDefinitionId(null)}
            />
          )
        })()}

      {editingInterfacePair &&
        architecture &&
        (() => {
          const { fromId, toId } = editingInterfacePair
          const from = architecture.elements.find((e) => e.id === fromId)
          const to = architecture.elements.find((e) => e.id === toId)
          return (
            <InterfaceEditorModal
              participantLabels={[from?.name ?? fromId, to?.name ?? toId]}
              operations={[]}
              onSave={(operations) =>
                handleSaveInterfaceDefinition(
                  undefined,
                  `${from?.name ?? fromId} ↔ ${to?.name ?? toId}`,
                  [
                    { elementId: fromId, role: 'both' },
                    { elementId: toId, role: 'both' },
                  ],
                  operations,
                )
              }
              onClose={() => setEditingInterfacePair(null)}
            />
          )
        })()}

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
