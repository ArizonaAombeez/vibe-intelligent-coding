import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AnalyseResult,
  ApplySplitRequirementResult,
  Architecture,
  ArchitectureTypeId,
  ConflictPair,
  CurrentOperation,
  ProjectMode,
  Requirement,
  ChatMessageLink,
  ScanCodeGapsOptions,
  TokenEstimate,
  VicCoreApi,
} from '../api/types'
import { QUALITY_SCORE_COLOR, REQUIREMENT_STATUS_LABEL, STATUS_COLOR } from '../statusColor'
import { toOperationError } from '../api/errorCode'
import { RequirementDetailPanel } from './RequirementDetailPanel'
import { RequirementResultsPanel } from './RequirementResultsPanel'
import { highlightRequirementIds } from './requirementIdHighlight'
import { EditableProposalCard } from './EditableProposalCard'
import { ChatDock } from '../components/ChatDock'
import type { PendingChatNav } from '../navigation/chatLinkNav'
import { ImportCodebaseDialog } from '../components/ImportCodebaseDialog'
import { ImportCodeGapScanDialog } from '../components/ImportCodeGapScanDialog'
import '../components/ModalOverlay.css'
import './RequirementsScreen.css'

const UNALLOCATED_GROUP = 'Unallocated to Architecture'

interface RequirementsScreenProps {
  api: VicCoreApi
  projectId: string
  activeSubstep: string | null
  onOperationChange: (op: CurrentOperation) => void
  architectureType: ArchitectureTypeId | null
  onGoToArchitecture: () => void
  onOpenSettings: () => void
  projectMode: ProjectMode
  // Whether a codebase zip has already been uploaded for this project
  // (project.importedCode !== undefined on reopen, via the /import-status
  // route) — seeds importedCodePresent below so the "Scan Code for
  // Requirement Gaps" action is correctly enabled after a reload, not just
  // within the session the upload happened in.
  importedCodePresent: boolean
  // Chat link chip clicked anywhere in the app — App switches phase and
  // sets pendingChatNav; this screen consumes it when kind === 'requirement'.
  onChatNavigate: (link: ChatMessageLink) => void
  pendingChatNav: PendingChatNav | null
  onChatNavConsumed: () => void
}


// Side panel (Results / Requirement detail) width as a fraction of the
// requirements-body container, so it responds to window/container resizes
// (fullscreen, half-screen) automatically via CSS flex-basis instead of a
// fixed pixel value.
const DEFAULT_DETAIL_FRACTION = 0.4
const MIN_DETAIL_FRACTION = 0.4
const MAX_DETAIL_FRACTION = 0.8

export function RequirementsScreen({
  api,
  projectId,
  activeSubstep,
  onOperationChange,
  architectureType,
  onGoToArchitecture,
  onOpenSettings,
  projectMode,
  importedCodePresent: importedCodePresentProp,
  onChatNavigate,
  pendingChatNav,
  onChatNavConsumed,
}: RequirementsScreenProps) {
  const [requirements, setRequirements] = useState<Requirement[]>([])
  // Shown once for an 'import' mode project until its codebase zip has been
  // uploaded (see api.importCodebase) — skipped on reopen if a codebase was
  // already uploaded in an earlier session (importedCodePresentProp).
  const [importDialogOpen, setImportDialogOpen] = useState(
    projectMode === 'import' && !importedCodePresentProp,
  )
  const [architecture, setArchitecture] = useState<Architecture | null>(null)
  const [formText, setFormText] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [openRequirementId, setOpenRequirementId] = useState<string | null>(null)
  // The side panel shows either the last analysis/conflicts/gaps run, or a
  // single requirement's detail — whichever the user looked at most recently.
  const [sidePanelView, setSidePanelView] = useState<'results' | 'detail'>('detail')

  // Analyst-chat proposal cards still live here (surface-specific side
  // content rendered under the shared ChatDock's transcript).
  const [proposed, setProposed] = useState<string[]>([])

  const [detailFraction, setDetailFraction] = useState(DEFAULT_DETAIL_FRACTION)
  const detailResizingRef = useRef(false)
  const requirementsBodyRef = useRef<HTMLDivElement>(null)

  const [analysing, setAnalysing] = useState(false)
  const [analysisResults, setAnalysisResults] = useState<AnalyseResult[]>([])
  // Pre-flight estimate shown before a Review Clarity run actually fires —
  // pendingAnalysisIds holds the requirement ids the confirm dialog would
  // run against, null when the dialog is closed.
  const [pendingAnalysisIds, setPendingAnalysisIds] = useState<string[] | null>(null)
  const [pendingEstimate, setPendingEstimate] = useState<TokenEstimate | null>(null)
  const [estimating, setEstimating] = useState(false)

  // Requirement ids with a "Review Complete" call in flight — tracked as a
  // set (not one shared boolean) so marking one row complete doesn't disable
  // the button on every other row while its request is outstanding.
  const [completingIds, setCompletingIds] = useState<Set<string>>(new Set())

  const [checkingConflicts, setCheckingConflicts] = useState(false)
  const [conflictPairs, setConflictPairs] = useState<ConflictPair[]>([])
  const [conflictsChecked, setConflictsChecked] = useState(false)

  const [checkingGaps, setCheckingGaps] = useState(false)
  const [gapSuggestions, setGapSuggestions] = useState<string[]>([])

  // Code gap scan (Import Project, REQ-056) — scans the already-uploaded
  // codebase (see importDialogOpen/ImportCodebaseDialog above) against the
  // current confirmed requirements. Only meaningful once a codebase has
  // been imported, hence gated on importedCodePresent below.
  const [scanningCodeGaps, setScanningCodeGaps] = useState(false)
  const [codeGapSuggestions, setCodeGapSuggestions] = useState<string[]>([])
  const [importedCodePresent, setImportedCodePresent] = useState(importedCodePresentProp)
  // Pre-flight token estimate dialog (ImportCodeGapScanDialog) shown before
  // the actual scan runs, so the user sees per-file/total size and picks a
  // mode before committing to a call that might otherwise exceed the
  // model's context window — see runScanCodeGaps below.
  const [codeGapScanDialogOpen, setCodeGapScanDialogOpen] = useState(false)

  const [binOpen, setBinOpen] = useState(false)
  const [deletedRequirements, setDeletedRequirements] = useState<Requirement[]>([])
  const [draggingRequirementId, setDraggingRequirementId] = useState<string | null>(null)

  // Persisted per-project (see api.getCollapsedRequirementGroups) so a
  // collapsed architecture-element group stays collapsed next time the
  // project is opened, rather than resetting to fully-expanded on reload.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())

  const [scoreFilterOp, setScoreFilterOp] = useState<'above' | 'below' | null>(null)
  const [scoreFilterValue, setScoreFilterValue] = useState(3)
  const [conflictsOnlyFilter, setConflictsOnlyFilter] = useState(false)
  const [noAnalysisFilter, setNoAnalysisFilter] = useState(false)
  const [noConflictCheckFilter, setNoConflictCheckFilter] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    api.listRequirements(projectId).then((list) => {
      if (cancelled) return
      setRequirements(list)
      setOpenRequirementId((prev) => prev ?? list[0]?.id ?? null)
    })
    api.getArchitecture(projectId).then((arch) => {
      if (cancelled) return
      setArchitecture(arch)
    })
    // Hydrates the last Check Conflicts / Check Gaps run from the project
    // itself (see modules/requirements-elicitation's lastConflictCheck/
    // lastGapCheck) so the results panel still shows the last real run
    // after navigating away and back, instead of only existing as
    // transient state that's lost on remount.
    api.getLastChecks(projectId).then((lastChecks) => {
      if (cancelled) return
      if (lastChecks.lastConflictCheck) {
        setConflictPairs(lastChecks.lastConflictCheck.pairs)
        setConflictsChecked(true)
      }
      if (lastChecks.lastGapCheck) {
        setGapSuggestions(lastChecks.lastGapCheck.suggestions)
      }
    })
    api.getCollapsedRequirementGroups(projectId).then((groupNames) => {
      if (cancelled) return
      setCollapsedGroups(new Set(groupNames))
    })
    return () => {
      cancelled = true
    }
  }, [api, projectId])


  const handleDetailResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const containerWidth = requirementsBodyRef.current?.getBoundingClientRect().width
      if (!containerWidth) return
      detailResizingRef.current = true
      const startX = e.clientX
      const startFraction = detailFraction

      function onMove(moveEvent: MouseEvent) {
        if (!detailResizingRef.current) return
        const delta = startX - moveEvent.clientX
        const next = Math.min(
          MAX_DETAIL_FRACTION,
          Math.max(MIN_DETAIL_FRACTION, startFraction + delta / containerWidth!),
        )
        setDetailFraction(next)
      }
      function onUp() {
        detailResizingRef.current = false
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [detailFraction],
  )

  const elementNameById = useMemo(() => {
    const map = new Map<string, string>()
    for (const element of architecture?.elements ?? []) {
      map.set(element.id, element.name)
    }
    return map
  }, [architecture])

  // Score filter deliberately never hides an unscored requirement (no
  // Review Clarity run yet) — a threshold has nothing to compare against,
  // and the user has the separate "no analysis performed" filter to find
  // those specifically.
  const anyFilterActive =
    scoreFilterOp !== null || conflictsOnlyFilter || noAnalysisFilter || noConflictCheckFilter

  const filteredRequirements = useMemo(() => {
    if (!anyFilterActive) return requirements
    return requirements.filter((r) => {
      if (scoreFilterOp && r.qualityScore) {
        if (scoreFilterOp === 'above' && !(r.qualityScore.score > scoreFilterValue)) return false
        if (scoreFilterOp === 'below' && !(r.qualityScore.score < scoreFilterValue)) return false
      }
      if (conflictsOnlyFilter && !(r.conflicts && r.conflicts.length > 0)) return false
      if (noAnalysisFilter && r.analystNote) return false
      if (noConflictCheckFilter && r.conflictsCheckedAt) return false
      return true
    })
  }, [requirements, anyFilterActive, scoreFilterOp, scoreFilterValue, conflictsOnlyFilter, noAnalysisFilter, noConflictCheckFilter])

  // Grouped by allocated architecture element(s) — populated automatically
  // once an architecture exists and allocation has run (Area B). A
  // requirement with 0 elements groups under "Unallocated to Architecture";
  // one with 1+ elements appears once per element it's allocated to
  // (duplicated rows across groups) — this is how a requirement allocated
  // to more than one element (interface/shared work) is expressed in this
  // list, without needing a structural redesign of the single-group-per-row
  // list UI itself.
  const groupedRequirements = useMemo(() => {
    const groups = new Map<string, Requirement[]>()
    function addTo(groupName: string, r: Requirement) {
      const existing = groups.get(groupName)
      if (existing) existing.push(r)
      else groups.set(groupName, [r])
    }
    for (const r of filteredRequirements) {
      if (r.architectureElements.length === 0) {
        addTo(UNALLOCATED_GROUP, r)
      } else {
        for (const elementId of r.architectureElements) addTo(elementId, r)
      }
    }
    return Array.from(groups.entries()).sort(([a], [b]) => {
      if (a === UNALLOCATED_GROUP) return 1
      if (b === UNALLOCATED_GROUP) return -1
      return a.localeCompare(b)
    })
  }, [filteredRequirements])

  // ChatDock transport for the Analyst surface. Errors propagate to the
  // dock (which shows them + an "llm-not-configured → Open Settings"
  // affordance); we still surface them on the status strip too.
  const sendAnalystChat = useCallback(
    async (sessionId: string, message: string) => {
      onOperationChange({ text: 'Analyst is thinking...' })
      try {
        const result = await api.analystChat(projectId, message, sessionId)
        setProposed((prev) => [...prev, ...result.proposedRequirements])
        onOperationChange({ text: null })
        return { userMessage: result.userMessage, assistantMessage: result.assistantMessage }
      } catch (err) {
        onOperationChange(toOperationError(err))
        throw err
      }
    },
    [api, projectId, onOperationChange],
  )

  // Consume a chat link chip that targeted a requirement — open that
  // requirement's detail panel, then tell App the nav is done.
  useEffect(() => {
    if (!pendingChatNav || pendingChatNav.kind !== 'requirement') return
    setOpenRequirementId(pendingChatNav.id)
    setSidePanelView('detail')
    onChatNavConsumed()
  }, [pendingChatNav, onChatNavConsumed])

  if (activeSubstep && activeSubstep !== 'elicitation') {
    return (
      <div className="requirements-screen">
        <h1>Requirements — {activeSubstep}</h1>
        <p className="requirements-screen-note">
          This substep isn't implemented yet — only Elicitation is available so far.
        </p>
      </div>
    )
  }

  async function handleFormSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!formText.trim()) return
    const requirement = await api.createRequirement(projectId, formText.trim())
    setRequirements((prev) => [...prev, requirement])
    setOpenRequirementId((prev) => prev ?? requirement.id)
    setFormText('')
  }

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleGroupSelected(groupRequirements: Requirement[], allSelected: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      for (const r of groupRequirements) {
        if (allSelected) next.delete(r.id)
        else next.add(r.id)
      }
      return next
    })
  }

  function persistCollapsedGroups(next: Set<string>) {
    setCollapsedGroups(next)
    api.setCollapsedRequirementGroups(projectId, Array.from(next))
  }

  function toggleGroupCollapsed(groupName: string) {
    const next = new Set(collapsedGroups)
    if (next.has(groupName)) next.delete(groupName)
    else next.add(groupName)
    persistCollapsedGroups(next)
  }

  function collapseAllGroups() {
    persistCollapsedGroups(new Set(groupedRequirements.map(([groupName]) => groupName)))
  }

  function expandAllGroups() {
    persistCollapsedGroups(new Set())
  }

  async function runAnalysis(requirementIds: string[]) {
    if (requirementIds.length === 0 || analysing) return
    setAnalysing(true)
    onOperationChange({ text: 'Reviewing clarity...' })
    try {
      const results = await api.analyseRequirements(projectId, requirementIds)
      setAnalysisResults(results)
      setSidePanelView('results')
      setRequirements((prev) =>
        prev.map((r) => {
          const result = results.find((res) => res.requirementId === r.id)
          return result ? { ...r, analystNote: result.note, qualityScore: result.qualityScore } : r
        }),
      )
      onOperationChange({ text: null })
    } catch (err) {
      onOperationChange(toOperationError(err))
    } finally {
      setAnalysing(false)
    }
  }

  // Review Clarity now runs as a single batched call over every targeted
  // requirement (see the requirements-elicitation module) rather than one
  // call per requirement, so it's worth a pre-flight token estimate before
  // committing — especially since a large batch is the one case where the
  // combined prompt could approach the model's context limit.
  async function handleReviewClarityClick(requirementIds: string[]) {
    if (requirementIds.length === 0 || analysing || estimating) return
    setEstimating(true)
    try {
      const estimate = await api.estimateAnalysisTokens(projectId, requirementIds)
      setPendingEstimate(estimate)
      setPendingAnalysisIds(requirementIds)
    } catch (err) {
      onOperationChange(toOperationError(err))
    } finally {
      setEstimating(false)
    }
  }

  function closePendingAnalysis() {
    setPendingAnalysisIds(null)
    setPendingEstimate(null)
  }

  async function confirmPendingAnalysis() {
    const ids = pendingAnalysisIds
    closePendingAnalysis()
    if (ids) await runAnalysis(ids)
  }

  async function runCheckConflicts() {
    if (checkingConflicts || requirements.length === 0) return
    setCheckingConflicts(true)
    onOperationChange({ text: 'Checking conflicts...' })
    try {
      const result = await api.checkConflicts(projectId)
      setConflictPairs(result.pairs)
      setConflictsChecked(true)
      setSidePanelView('results')
      setRequirements(result.requirements)
      onOperationChange({ text: null })
    } catch (err) {
      onOperationChange(toOperationError(err))
    } finally {
      setCheckingConflicts(false)
    }
  }

  async function runCheckGaps() {
    if (checkingGaps || requirements.length === 0) return
    setCheckingGaps(true)
    onOperationChange({ text: 'Checking gaps...' })
    try {
      const suggestions = await api.checkGaps(projectId)
      setGapSuggestions(suggestions)
      setSidePanelView('results')
      onOperationChange({ text: null })
    } catch (err) {
      onOperationChange(toOperationError(err))
    } finally {
      setCheckingGaps(false)
    }
  }

  async function handleAcceptGap(text: string, originalText: string) {
    const requirement = await api.createRequirement(projectId, text)
    setRequirements((prev) => [...prev, requirement])
    setOpenRequirementId((prev) => prev ?? requirement.id)
    setGapSuggestions((prev) => prev.filter((s) => s !== originalText))
  }

  function handleDiscardGap(text: string) {
    setGapSuggestions((prev) => prev.filter((s) => s !== text))
  }

  async function runScanCodeGaps(options: ScanCodeGapsOptions) {
    if (scanningCodeGaps || !importedCodePresent) return
    setCodeGapScanDialogOpen(false)
    setScanningCodeGaps(true)
    onOperationChange({
      text:
        options.mode === 'per-file'
          ? 'Scanning code for requirement gaps (one file at a time)...'
          : 'Scanning code for requirement gaps...',
    })
    try {
      const result = await api.scanCodeGaps(projectId, options)
      setCodeGapSuggestions(result.proposedRequirements)
      setSidePanelView('results')
      onOperationChange({ text: null })
    } catch (err) {
      onOperationChange(toOperationError(err))
    } finally {
      setScanningCodeGaps(false)
    }
  }

  async function handleAcceptCodeGap(text: string, originalText: string) {
    const [requirement] = await api.acceptImportedRequirements(projectId, [text], 'reverse-elicited-code')
    setRequirements((prev) => [...prev, requirement])
    setOpenRequirementId((prev) => prev ?? requirement.id)
    setCodeGapSuggestions((prev) => prev.filter((s) => s !== originalText))
  }

  function handleDiscardCodeGap(text: string) {
    setCodeGapSuggestions((prev) => prev.filter((s) => s !== text))
  }

  function handleImportClick() {
    fileInputRef.current?.click()
  }

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const text = await file.text()
    try {
      const created = await api.importRequirements(projectId, text)
      setRequirements((prev) => [...prev, ...created])
      setOpenRequirementId((prev) => prev ?? created[0]?.id ?? null)
    } catch (err) {
      onOperationChange(toOperationError(err))
    }
  }

  async function handleAcceptProposal(text: string, originalText: string) {
    const requirement = await api.acceptProposedRequirement(projectId, text)
    setRequirements((prev) => [...prev, requirement])
    setOpenRequirementId((prev) => prev ?? requirement.id)
    setProposed((prev) => prev.filter((p) => p !== originalText))
  }

  function handleDiscardProposal(text: string) {
    setProposed((prev) => prev.filter((p) => p !== text))
  }

  async function handleSaveRequirementText(id: string, text: string) {
    const updated = await api.updateRequirement(projectId, id, text)
    setRequirements((prev) => prev.map((r) => (r.id === id ? updated : r)))
  }

  async function handleReviewComplete(ids: string[]) {
    const targets = ids.filter((id) => {
      const requirement = requirements.find((r) => r.id === id)
      return requirement && requirement.status !== 'complete'
    })
    if (targets.length === 0) return
    setCompletingIds((prev) => new Set([...prev, ...targets]))
    try {
      const updated = await Promise.all(
        targets.map((id) => api.setRequirementStatus(projectId, id, 'complete')),
      )
      setRequirements((prev) => prev.map((r) => updated.find((u) => u.id === r.id) ?? r))
    } finally {
      setCompletingIds((prev) => {
        const next = new Set(prev)
        for (const id of targets) next.delete(id)
        return next
      })
    }
  }

  async function handleDeleteRequirement(id: string) {
    await api.deleteRequirement(projectId, id)
    const deleted = requirements.find((r) => r.id === id)
    setRequirements((prev) => prev.filter((r) => r.id !== id))
    setSelectedIds((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
    if (openRequirementId === id) setOpenRequirementId(null)
    if (deleted) setDeletedRequirements((prev) => [...prev, { ...deleted, deletedAt: new Date().toISOString() }])
  }

  async function openBin() {
    const list = await api.listDeletedRequirements(projectId)
    setDeletedRequirements(list)
    setBinOpen(true)
  }

  async function handleRestoreRequirement(id: string) {
    const restored = await api.restoreRequirement(projectId, id)
    setDeletedRequirements((prev) => prev.filter((r) => r.id !== id))
    setRequirements((prev) => [...prev, restored])
  }

  async function handlePurgeRequirement(id: string) {
    if (!window.confirm('Permanently delete this requirement? This cannot be undone.')) return
    await api.purgeRequirement(projectId, id)
    setDeletedRequirements((prev) => prev.filter((r) => r.id !== id))
  }

  function handleSplitApplied(result: ApplySplitRequirementResult) {
    const originalId = openRequirementId
    setRequirements((prev) => [
      ...prev.filter((r) => r.id !== originalId),
      ...result.createdRequirements,
    ])
    setSelectedIds((prev) => {
      if (!originalId || !prev.has(originalId)) return prev
      const next = new Set(prev)
      next.delete(originalId)
      return next
    })
    setOpenRequirementId(result.createdRequirements[0]?.id ?? null)
  }

  async function handleAddElement(requirementId: string, elementId: string) {
    const updated = await api.addRequirementToElement(projectId, requirementId, elementId)
    setRequirements((prev) => prev.map((r) => (r.id === requirementId ? updated : r)))
  }

  async function handleRemoveElement(requirementId: string, elementId: string) {
    const updated = await api.removeRequirementFromElement(projectId, requirementId, elementId)
    setRequirements((prev) => prev.map((r) => (r.id === requirementId ? updated : r)))
  }

  // Dropping onto a real element group ADDS that allocation (never
  // replaces — multi-element allocation, confirmed design decision).
  // Dropping onto "Unallocated" removes the requirement from whichever
  // group it was actually dragged out of (carried in the drag payload as
  // sourceGroup), not from every element it might be allocated to.
  async function handleDropOnGroup(groupName: string, e: React.DragEvent) {
    e.preventDefault()
    const raw = e.dataTransfer.getData('text/plain')
    setDraggingRequirementId(null)
    if (!raw) return
    let payload: { requirementId: string; sourceGroup: string }
    try {
      payload = JSON.parse(raw)
    } catch {
      return
    }
    const { requirementId, sourceGroup } = payload
    const requirement = requirements.find((r) => r.id === requirementId)
    if (!requirement) return

    if (groupName === UNALLOCATED_GROUP) {
      if (sourceGroup === UNALLOCATED_GROUP) return
      const updated = await api.removeRequirementFromElement(projectId, requirementId, sourceGroup)
      setRequirements((prev) => prev.map((r) => (r.id === requirementId ? updated : r)))
      return
    }

    if (requirement.architectureElements.includes(groupName)) return
    const updated = await api.addRequirementToElement(projectId, requirementId, groupName)
    setRequirements((prev) => prev.map((r) => (r.id === requirementId ? updated : r)))
  }

  const openRequirement = requirements.find((r) => r.id === openRequirementId) ?? null
  const hasResults =
    analysisResults.length > 0 || conflictsChecked || gapSuggestions.length > 0 || codeGapSuggestions.length > 0

  return (
    <div className="requirements-screen">
      <h1>Requirements — Elicitation</h1>

      {!architectureType && (
        <p className="requirements-architecture-notice">
          Select Architecture model in the{' '}
          <button type="button" className="requirements-architecture-link" onClick={onGoToArchitecture}>
            Architecture Tab
          </button>
        </p>
      )}

      <div className="requirements-action-bar">
        <button
          type="button"
          onClick={() => handleReviewClarityClick(requirements.map((r) => r.id))}
          disabled={analysing || estimating || requirements.length === 0}
          title="Single batched LLM review of clarity, atomicity, and EARS pattern compliance across every requirement."
        >
          Review Clarity (All)
        </button>
        <button
          type="button"
          onClick={() => handleReviewClarityClick(Array.from(selectedIds))}
          disabled={analysing || estimating || selectedIds.size === 0}
          title="Review only the checked requirements below."
        >
          Review Clarity (Selected) {selectedIds.size > 0 ? `(${selectedIds.size})` : ''}
        </button>
        <button
          type="button"
          onClick={() => handleReviewComplete(Array.from(selectedIds))}
          disabled={selectedIds.size === 0 || Array.from(selectedIds).every((id) => completingIds.has(id))}
          title="Mark the checked requirements as reviewed and complete."
        >
          Review Complete {selectedIds.size > 0 ? `(${selectedIds.size})` : ''}
        </button>
        <button
          type="button"
          onClick={runCheckConflicts}
          disabled={checkingConflicts || requirements.length === 0}
          title="One LLM call across the whole requirement set, looking for contradicting, duplicate, or overlapping requirements."
        >
          Check Conflicts
        </button>
        <button
          type="button"
          onClick={runCheckGaps}
          disabled={checkingGaps || requirements.length === 0}
          title="One LLM call across the whole requirement set, looking for missing or implied requirements not yet captured."
        >
          Check Gaps
        </button>
        {projectMode === 'import' && (
          <button
            type="button"
            onClick={() => setCodeGapScanDialogOpen(true)}
            disabled={scanningCodeGaps || !importedCodePresent}
            title={
              importedCodePresent
                ? 'One LLM call over the imported codebase, proposing requirements only for behaviour not already covered by an existing requirement.'
                : 'Upload a codebase first (see Import Project) before scanning it for requirement gaps.'
            }
          >
            Scan Code for Requirement Gaps
          </button>
        )}
        <button
          type="button"
          className="requirements-action-secondary"
          onClick={handleImportClick}
        >
          Import from file...
        </button>
        <button
          type="button"
          className="requirements-action-secondary"
          onClick={openBin}
          title="View deleted requirements — restore or permanently delete."
        >
          Bin{deletedRequirements.length > 0 ? ` (${deletedRequirements.length})` : ''}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".txt"
          className="requirements-file-input"
          onChange={handleImportFile}
        />
      </div>

      <div className="requirements-filter-bar">
        <button type="button" className="requirements-action-secondary" onClick={expandAllGroups}>
          Expand all
        </button>
        <button type="button" className="requirements-action-secondary" onClick={collapseAllGroups}>
          Collapse all
        </button>
        <span className="requirements-filter-divider" />
        <label className="requirements-filter-score">
          <select
            value={scoreFilterOp ?? ''}
            onChange={(e) => setScoreFilterOp(e.target.value === '' ? null : (e.target.value as 'above' | 'below'))}
          >
            <option value="">Score...</option>
            <option value="above">Score above</option>
            <option value="below">Score below</option>
          </select>
          {scoreFilterOp && (
            <input
              type="number"
              min={1}
              max={5}
              step={0.5}
              value={scoreFilterValue}
              onChange={(e) => setScoreFilterValue(Number(e.target.value))}
            />
          )}
        </label>
        <label className="requirements-filter-checkbox">
          <input
            type="checkbox"
            checked={conflictsOnlyFilter}
            onChange={(e) => setConflictsOnlyFilter(e.target.checked)}
          />
          Has conflicts
        </label>
        <label className="requirements-filter-checkbox">
          <input
            type="checkbox"
            checked={noAnalysisFilter}
            onChange={(e) => setNoAnalysisFilter(e.target.checked)}
          />
          No clarity review yet
        </label>
        <label className="requirements-filter-checkbox">
          <input
            type="checkbox"
            checked={noConflictCheckFilter}
            onChange={(e) => setNoConflictCheckFilter(e.target.checked)}
          />
          No conflict check yet
        </label>
        {anyFilterActive && (
          <button
            type="button"
            className="requirements-action-secondary"
            onClick={() => {
              setScoreFilterOp(null)
              setConflictsOnlyFilter(false)
              setNoAnalysisFilter(false)
              setNoConflictCheckFilter(false)
            }}
          >
            Clear filters
          </button>
        )}
        {anyFilterActive && (
          <span className="requirements-filter-count">
            {filteredRequirements.length} of {requirements.length}
          </span>
        )}
      </div>

      <div className="requirements-body" ref={requirementsBodyRef}>
      <div className="requirements-main">
        <section className="requirements-form-panel">
          <form onSubmit={handleFormSubmit}>
            <textarea
              value={formText}
              onChange={(e) => setFormText(e.target.value)}
              placeholder='e.g. "The system shall allow a user to reset their password"'
              rows={2}
            />
            <button type="submit" disabled={!formText.trim()}>
              Add requirement
            </button>
          </form>

          {requirements.length === 0 && (
            <p className="requirements-list-empty">No requirements yet.</p>
          )}
          {groupedRequirements.map(([groupName, groupRequirements]) => {
            const groupSelectedCount = groupRequirements.filter((r) => selectedIds.has(r.id)).length
            const allGroupSelected = groupSelectedCount === groupRequirements.length
            const isCollapsed = collapsedGroups.has(groupName)
            return (
            <div key={groupName} className="requirements-group">
              <h2 className="requirements-group-heading">
                <button
                  type="button"
                  className="requirements-group-collapse-toggle"
                  onClick={() => toggleGroupCollapsed(groupName)}
                  aria-label={isCollapsed ? `Expand ${groupName}` : `Collapse ${groupName}`}
                  aria-expanded={!isCollapsed}
                >
                  {isCollapsed ? '▶' : '▼'}
                </button>
                <input
                  type="checkbox"
                  className="requirements-group-select-all"
                  checked={allGroupSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = groupSelectedCount > 0 && !allGroupSelected
                  }}
                  onChange={() => toggleGroupSelected(groupRequirements, allGroupSelected)}
                  title={allGroupSelected ? 'Deselect all in this group' : 'Select all in this group'}
                  aria-label={`Select all requirements in ${groupName}`}
                />
                {groupName}
                {elementNameById.has(groupName) && (
                  <span className="requirements-group-element-name"> — {elementNameById.get(groupName)}</span>
                )}
                <span className="requirements-group-count">{groupRequirements.length}</span>
              </h2>
              {!isCollapsed && (
              <ul
                className={`requirements-list ${draggingRequirementId ? 'requirements-list-drop-target' : ''}`}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => handleDropOnGroup(groupName, e)}
              >
                {groupRequirements.map((r) => (
                  <li
                    key={r.id}
                    draggable
                    onDragStart={(e) => {
                      // Payload carries the source group (not just the
                      // requirement id) so a drop onto "Unallocated" knows
                      // which specific element allocation to remove — a
                      // multi-allocated requirement's row can appear in
                      // several groups at once, and only the group it was
                      // actually dragged out of should be affected.
                      e.dataTransfer.setData('text/plain', JSON.stringify({ requirementId: r.id, sourceGroup: groupName }))
                      e.dataTransfer.effectAllowed = 'move'
                      setDraggingRequirementId(r.id)
                    }}
                    onDragEnd={() => setDraggingRequirementId(null)}
                    className={`requirements-list-row ${r.id === openRequirementId && sidePanelView === 'detail' ? 'active' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedIds.has(r.id)}
                      onChange={() => toggleSelected(r.id)}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <button
                      type="button"
                      className="requirements-list-row-main"
                      onClick={() => {
                        setOpenRequirementId(r.id)
                        setSidePanelView('detail')
                      }}
                    >
                      <span
                        className="requirements-list-dot"
                        style={{
                          background:
                            STATUS_COLOR[
                              r.status === 'complete' ? 'complete' : r.status === 'tested-fail' ? 'blocked' : 'in-progress'
                            ],
                        }}
                        title={REQUIREMENT_STATUS_LABEL[r.status]}
                      />
                      <span className="requirements-list-id">{r.id}</span>
                      <span className="requirements-list-text">{r.text}</span>
                      {r.qualityScore && (
                        <span
                          className="quality-score-badge"
                          style={{ background: QUALITY_SCORE_COLOR(r.qualityScore.score) }}
                          title={`Quality score: ${r.qualityScore.score}/5`}
                        >
                          {r.qualityScore.score}
                        </span>
                      )}
                      {r.conflicts && r.conflicts.length > 0 && (
                        <span
                          className="conflict-badge"
                          title={`Conflicts with ${r.conflicts.map((c) => c.requirementId).join(', ')}`}
                        >
                          ⚠ conflict
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      className="requirements-list-row-complete"
                      title={r.status === 'complete' ? 'Already marked complete' : 'Mark this requirement as reviewed and complete'}
                      aria-label="Review Complete"
                      disabled={r.status === 'complete' || completingIds.has(r.id)}
                      onClick={(e) => {
                        e.stopPropagation()
                        handleReviewComplete([r.id])
                      }}
                    >
                      ✓ Review Complete
                    </button>
                    <button
                      type="button"
                      className="requirements-list-row-delete"
                      title="Delete requirement (moves to Bin)"
                      aria-label="Delete requirement"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDeleteRequirement(r.id)
                      }}
                    >
                      🗑
                    </button>
                  </li>
                ))}
              </ul>
              )}
            </div>
            )
          })}
        </section>
      </div>

      {sidePanelView === 'results' ? (
        <RequirementResultsPanel
          widthPercent={detailFraction * 100}
          onResizeStart={handleDetailResizeStart}
          analysisResults={analysisResults}
          conflictsChecked={conflictsChecked}
          conflictPairs={conflictPairs}
          gapSuggestions={gapSuggestions}
          checkingGaps={checkingGaps}
          onAcceptGap={handleAcceptGap}
          onDiscardGap={handleDiscardGap}
          codeGapSuggestions={codeGapSuggestions}
          scanningCodeGaps={scanningCodeGaps}
          onAcceptCodeGap={handleAcceptCodeGap}
          onDiscardCodeGap={handleDiscardCodeGap}
          onBackToDetail={() => setSidePanelView('detail')}
          hasOpenRequirement={openRequirement !== null}
        />
      ) : openRequirement ? (
        <RequirementDetailPanel
          api={api}
          projectId={projectId}
          requirement={openRequirement}
          architecture={architecture}
          onSave={(text) => handleSaveRequirementText(openRequirement.id, text)}
          widthPercent={detailFraction * 100}
          onResizeStart={handleDetailResizeStart}
          hasResults={hasResults}
          onShowResults={() => setSidePanelView('results')}
          onSplitApplied={handleSplitApplied}
          onAddElement={(elementId) => handleAddElement(openRequirement.id, elementId)}
          onRemoveElement={(elementId) => handleRemoveElement(openRequirement.id, elementId)}
        />
      ) : (
        <div
          className="requirement-detail-empty"
          style={{ flexBasis: `${detailFraction * 100}%` }}
        >
          No requirement selected.
        </div>
      )}
      </div>

      <ChatDock
        api={api}
        projectId={projectId}
        surface="analyst"
        roleLabel="Analyst"
        heading="Analyst chat"
        hint="Ask the Analyst to help clarify or fill gaps in your requirements."
        placeholder="Message the Analyst... (Shift+Enter for a new line)"
        onOpenSettings={onOpenSettings}
        onNavigateLink={onChatNavigate}
        renderMessageText={highlightRequirementIds}
        sendMessage={sendAnalystChat}
        renderExtras={() =>
          proposed.length > 0 ? (
            <div className="analyst-chat-proposals">
              <h3>Proposed requirements</h3>
              {proposed.map((text) => (
                <EditableProposalCard
                  key={text}
                  text={text}
                  onAccept={(edited) => handleAcceptProposal(edited, text)}
                  onDiscard={handleDiscardProposal}
                />
              ))}
            </div>
          ) : null
        }
      />

      {pendingAnalysisIds && pendingEstimate && (
        <div className="modal-overlay" onClick={closePendingAnalysis}>
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <div className="requirement-detail-header">
              <span className="requirement-detail-id">Review Clarity</span>
              <button type="button" className="requirement-detail-edit-btn" onClick={closePendingAnalysis}>
                Cancel
              </button>
            </div>
            <p>
              Reviewing {pendingAnalysisIds.length} requirement{pendingAnalysisIds.length === 1 ? '' : 's'}{' '}
              in a single call: ~{pendingEstimate.inputTokens.toLocaleString()} input tokens + ~
              {pendingEstimate.estimatedOutputTokens.toLocaleString()} estimated output tokens (~
              {pendingEstimate.totalTokens.toLocaleString()} total, estimated).
            </p>
            {pendingEstimate.nearContextLimit && (
              <p className="analyst-chat-error">
                Approaching the model's context limit (~{pendingEstimate.warnAt.toLocaleString()} of{' '}
                {pendingEstimate.contextWindow.toLocaleString()} tokens) — consider reviewing a smaller
                selection instead of the full set.
              </p>
            )}
            <div className="analyst-chat-proposal-actions">
              <button type="button" onClick={confirmPendingAnalysis}>
                Run Review Clarity
              </button>
              <button type="button" onClick={closePendingAnalysis}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {importDialogOpen && (
        <ImportCodebaseDialog
          api={api}
          projectId={projectId}
          onClose={() => setImportDialogOpen(false)}
          onImported={(result) => {
            setImportedCodePresent(true)
            if (result.requirementsImportedCount > 0) {
              api.listRequirements(projectId).then(setRequirements)
            }
          }}
        />
      )}

      {codeGapScanDialogOpen && (
        <ImportCodeGapScanDialog
          api={api}
          projectId={projectId}
          onClose={() => setCodeGapScanDialogOpen(false)}
          onConfirm={runScanCodeGaps}
        />
      )}

      {binOpen && (
        <div className="modal-overlay" onClick={() => setBinOpen(false)}>
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <div className="requirement-detail-header">
              <span className="requirement-detail-id">Bin</span>
              <button type="button" className="requirement-detail-edit-btn" onClick={() => setBinOpen(false)}>
                Close
              </button>
            </div>
            {deletedRequirements.length === 0 ? (
              <p className="requirements-check-empty">Bin is empty.</p>
            ) : (
              deletedRequirements.map((r) => (
                <div key={r.id} className="analyst-chat-proposal">
                  <span className="requirements-list-id">{r.id}</span>
                  <p>{r.text}</p>
                  <div className="analyst-chat-proposal-actions">
                    <button type="button" onClick={() => handleRestoreRequirement(r.id)}>
                      Restore
                    </button>
                    <button type="button" onClick={() => handlePurgeRequirement(r.id)}>
                      Delete permanently
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
