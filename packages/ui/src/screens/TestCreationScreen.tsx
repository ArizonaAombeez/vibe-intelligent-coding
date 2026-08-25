import { useEffect, useRef, useState } from 'react'
import type {
  Architecture,
  ArchitectureElement,
  CurrentOperation,
  ImportedTestCaseSet,
  ProjectSettings,
  ProposedTest,
  RejectedProposal,
  Requirement,
  TestCase,
  TestSuite,
  TraceabilityRejectionReason,
  VicCoreApi,
} from '../api/types'
import { toOperationError } from '../api/errorCode'
import { STATUS_COLOR, STATUS_LABEL } from '../statusColor'
import { highlightRequirementIds } from './requirementIdHighlight'
import './RequirementsScreen.css'
import './TestCreationScreen.css'

interface TestCreationScreenProps {
  api: VicCoreApi
  projectId: string
  onOperationChange: (op: CurrentOperation) => void
  settings: ProjectSettings
  onSettingsChange: (settings: ProjectSettings) => void
  onOpenSettings: () => void
}

interface TestCreationChatEntry {
  role: 'user' | 'qa'
  text: string
}

// TestCaseStatus ('not-run'/'passing'/'failing') isn't literally the same
// type as Status, unlike StoryStatus — small local mapping onto the shared
// 4-colour scale.
const TEST_STATUS_COLOR: Record<TestCase['status'], string> = {
  'not-run': STATUS_COLOR['not-started'],
  passing: STATUS_COLOR.complete,
  failing: STATUS_COLOR.blocked,
}
const TEST_STATUS_LABEL: Record<TestCase['status'], string> = {
  'not-run': 'Not run',
  passing: STATUS_LABEL.complete,
  failing: STATUS_LABEL.blocked,
}

// Mirrors the mechanical traceability gate in createTestCase
// (modules/requirements-elicitation/src/testCreation.ts) — a manually
// entered test is rejected by that exact same gate, not a separate/looser
// check, so these messages describe the server's real reason back to the
// person filling in the Add form.
const TRACEABILITY_REJECTION_MESSAGE: Record<TraceabilityRejectionReason, string> = {
  'no-requirement-ids': 'Select at least one requirement for this functional test.',
  'requirement-not-found': 'One of the selected requirements no longer exists.',
  'requirement-not-allocated-to-element':
    'Every selected requirement must be allocated to the chosen architecture element.',
  'no-contract-ref': 'Select a connection for this integration test.',
  'contract-not-found': 'No interface contract exists for that connection.',
  'contract-not-defined': 'That connection\'s interface contract has no defined operations yet — run Define Interfaces first.',
}

const UNIT_TEST_MODE_RATIONALE: Record<ProjectSettings['unitTestMode'], string> = {
  llm: 'Functional tests are proposed purely from requirement text by the QA persona.',
  scaffold:
    'Scaffold mode currently behaves as LLM mode — full scaffold-first generation is not yet implemented for a specific test framework.',
  disabled: 'Functional test generation is skipped entirely — no LLM call is made.',
}

// Groups the flat test list by the architecture element it belongs to (or
// the interface pair, for integration tests) so the list stays scannable
// with hundreds/thousands of test cases — same grouping key as the element
// a test's generated file would live under.
function scopeKeyForTestCase(test: TestCase): string {
  if (test.interfaceElementIds) return `if:${[...test.interfaceElementIds].sort().join('|')}`
  return `el:${test.architectureElementId ?? 'unassigned'}`
}

function scopeLabelForTestCase(test: TestCase, elementNameById: Map<string, string>): string {
  if (test.interfaceElementIds) {
    const [fromId, toId] = test.interfaceElementIds
    return `${elementNameById.get(fromId) ?? fromId} <-> ${elementNameById.get(toId) ?? toId}`
  }
  if (!test.architectureElementId) return 'Unassigned'
  return elementNameById.get(test.architectureElementId) ?? test.architectureElementId
}

interface TestCreationGroup {
  scopeKey: string
  label: string
  tests: TestCase[]
}

function groupTestCasesByScope(tests: TestCase[], elementNameById: Map<string, string>): TestCreationGroup[] {
  const groups = new Map<string, TestCreationGroup>()
  for (const test of tests) {
    const scopeKey = scopeKeyForTestCase(test)
    let group = groups.get(scopeKey)
    if (!group) {
      group = { scopeKey, label: scopeLabelForTestCase(test, elementNameById), tests: [] }
      groups.set(scopeKey, group)
    }
    group.tests.push(test)
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label))
}

export function TestCreationScreen({
  api,
  projectId,
  onOperationChange,
  settings,
  onSettingsChange,
  onOpenSettings,
}: TestCreationScreenProps) {
  const [testSuite, setTestSuite] = useState<TestSuite | null>(null)
  const [architecture, setArchitecture] = useState<Architecture | null>(null)
  const [requirements, setRequirements] = useState<Requirement[]>([])
  const [selectedTestId, setSelectedTestId] = useState<string | null>(null)
  const [selectedElementId, setSelectedElementId] = useState('')
  const [selectedPairKey, setSelectedPairKey] = useState('')
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const collapsedGroupsInitialized = useRef(false)
  const [rejected, setRejected] = useState<RejectedProposal[]>([])
  const [busy, setBusy] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Manual "Add test case" form (separate from LLM proposal/generation) —
  // goes through the exact same createTestCase traceability gate as every
  // other path onto project.testSuite.tests, so a manually entered test
  // with no requirement/contract link is rejected identically, not
  // silently created.
  const [addFormOpen, setAddFormOpen] = useState(false)
  const [addType, setAddType] = useState<TestCase['type']>('functional')
  const [addTitle, setAddTitle] = useState('')
  const [addElementId, setAddElementId] = useState('')
  const [addRequirementIds, setAddRequirementIds] = useState<string[]>([])
  const [addPairKey, setAddPairKey] = useState('')
  const [addBusy, setAddBusy] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  const [editTitleValue, setEditTitleValue] = useState('')
  const [editTitleBusy, setEditTitleBusy] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [importedTestCases, setImportedTestCases] = useState<ImportedTestCaseSet | null>(null)
  const [importFolderPath, setImportFolderPath] = useState('')
  const [importBusy, setImportBusy] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [lastImportCount, setLastImportCount] = useState<number | null>(null)
  const [lastGenerateResult, setLastGenerateResult] = useState<{
    status: string
    diff: string
    rawLog: string
    rejectedFiles?: string[]
  } | null>(null)

  const [chatHistory, setChatHistory] = useState<TestCreationChatEntry[]>([])
  const [chatInput, setChatInput] = useState('')
  const [proposedTests, setProposedTests] = useState<ProposedTest[]>([])
  const [chatBusy, setChatBusy] = useState(false)
  const [chatError, setChatError] = useState<string | null>(null)
  const [chatErrorIsLlmNotConfigured, setChatErrorIsLlmNotConfigured] = useState(false)

  async function reload() {
    try {
      const [suite, arch, imported, reqs] = await Promise.all([
        api.getTestSuite(projectId),
        api.getArchitecture(projectId),
        api.getImportedTestCases(projectId),
        api.listRequirements(projectId),
      ])
      setTestSuite(suite)
      setArchitecture(arch)
      setImportedTestCases(imported)
      setRequirements(reqs)
      setLoadError(null)
    } catch (err) {
      setLoadError(toOperationError(err).error ?? 'Failed to load Test Creation data.')
    }
  }

  useEffect(() => {
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, projectId])

  const tests = (testSuite?.tests ?? []).filter((t) => !t.deletedAt)
  const selectedTest = tests.find((t) => t.id === selectedTestId) ?? null
  const elementNameById = new Map((architecture?.elements ?? []).map((e) => [e.id, e.name]))
  const testGroups = groupTestCasesByScope(tests, elementNameById)

  useEffect(() => {
    setEditTitleValue(selectedTest?.title ?? '')
  }, [selectedTest?.id, selectedTest?.title])

  useEffect(() => {
    if (collapsedGroupsInitialized.current || testGroups.length === 0) return
    collapsedGroupsInitialized.current = true
    setCollapsedGroups(new Set(testGroups.map((g) => g.scopeKey)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [testGroups.length])

  function toggleGroupCollapsed(scopeKey: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(scopeKey)) next.delete(scopeKey)
      else next.add(scopeKey)
      return next
    })
  }

  function expandAllGroups() {
    setCollapsedGroups(new Set())
  }

  function collapseAllGroups() {
    setCollapsedGroups(new Set(testGroups.map((g) => g.scopeKey)))
  }

  const connectedPairs: Array<{ fromId: string; toId: string; label: string }> = []
  if (architecture) {
    const seen = new Set<string>()
    for (const element of architecture.elements) {
      for (const toId of element.interfaces) {
        const key = [element.id, toId].sort().join('|')
        if (seen.has(key)) continue
        seen.add(key)
        connectedPairs.push({
          fromId: element.id,
          toId,
          label: `${elementNameById.get(element.id) ?? element.id} <-> ${elementNameById.get(toId) ?? toId}`,
        })
      }
    }
  }

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

  async function handleGenerateFunctional() {
    if (!selectedElementId) return
    await withBusyAction('QA is proposing functional tests...', async () => {
      const result = await api.generateFunctionalTests(projectId, selectedElementId)
      setRejected(result.rejected)
      await reload()
    })
  }

  async function handleGenerateIntegration() {
    if (!selectedPairKey) return
    const [fromId, toId] = selectedPairKey.split('|')
    await withBusyAction('QA is proposing integration tests...', async () => {
      const result = await api.generateIntegrationTests(projectId, fromId, toId)
      setRejected(result.rejected)
      await reload()
    })
  }

  async function handleGenerateAll() {
    await withBusyAction('QA is proposing tests...', async () => {
      const result = await api.generateAllTests(projectId)
      setRejected(result.rejected)
      await reload()
    })
  }

  async function handleGenerateFile(testId: string) {
    await withBusyAction('QA is writing the test file...', async () => {
      const result = await api.generateTestFile(projectId, testId)
      setLastGenerateResult(result)
      await reload()
    })
  }

  // Bulk sibling of handleGenerateFile — one test case at a time (not in
  // parallel), same rationale as CodingScreen's handleCodeAll: each call is
  // a real CLI invocation writing into the same shared source tree, and the
  // server's own per-project run lock (see acquireProjectRunLock) would
  // just reject a second concurrent one anyway. Skips any test case that
  // already has a generated file (filePath set) — "automations" here means
  // the test's runnable code, distinct from "Generate All Test Cases"
  // above, which only ever proposes/creates the traceability records, not
  // code.
  async function handleGenerateAllAutomations() {
    const pending = tests.filter((t) => !t.filePath)
    if (busy || pending.length === 0) return
    setBusy(true)
    try {
      for (const testCase of pending) {
        onOperationChange({ text: `QA is writing the test file for ${testCase.id}...` })
        const result = await api.generateTestFile(projectId, testCase.id)
        setLastGenerateResult(result)
      }
      await reload()
      onOperationChange({ text: null })
    } catch (err) {
      onOperationChange(toOperationError(err))
    } finally {
      setBusy(false)
    }
  }

  function resetAddForm() {
    setAddType('functional')
    setAddTitle('')
    setAddElementId('')
    setAddRequirementIds([])
    setAddPairKey('')
    setAddError(null)
  }

  function handleOpenAddForm() {
    resetAddForm()
    setAddFormOpen(true)
  }

  function toggleAddRequirementId(id: string) {
    setAddRequirementIds((prev) => (prev.includes(id) ? prev.filter((r) => r !== id) : [...prev, id]))
  }

  // Manually authored test cases go through the identical mechanical
  // traceability gate as an LLM-proposed one (createTestCase itself, not a
  // separate/looser check) — a rejection here is exactly the same class of
  // rejection shown in the rejected-proposals banner elsewhere on this
  // screen, just surfaced inline in the form instead.
  async function handleAddTestCase() {
    if (!addTitle.trim() || addBusy) return
    setAddBusy(true)
    setAddError(null)
    try {
      const fields =
        addType === 'functional'
          ? {
              type: 'functional' as const,
              title: addTitle.trim(),
              requirementIds: addRequirementIds,
              architectureElementId: addElementId || null,
            }
          : {
              type: 'integration' as const,
              title: addTitle.trim(),
              interfaceContractRef: addPairKey
                ? { fromId: addPairKey.split('|')[0], toId: addPairKey.split('|')[1] }
                : undefined,
              interfaceElementIds: addPairKey
                ? ([addPairKey.split('|')[0], addPairKey.split('|')[1]] as [string, string])
                : undefined,
            }
      const result = await api.createTestCase(projectId, fields)
      if (!result.testCase) {
        setAddError(
          result.rejected
            ? TRACEABILITY_REJECTION_MESSAGE[result.rejected]
            : 'This test case could not be created.',
        )
        return
      }
      await reload()
      setSelectedTestId(result.testCase.id)
      setAddFormOpen(false)
      resetAddForm()
    } catch (err) {
      setAddError(toOperationError(err).error ?? 'Failed to create test case.')
    } finally {
      setAddBusy(false)
    }
  }

  async function handleSaveTitle(testId: string) {
    if (!editTitleValue.trim() || editTitleBusy) return
    setEditTitleBusy(true)
    try {
      await api.updateTestCase(projectId, testId, { title: editTitleValue.trim() })
      await reload()
    } catch (err) {
      onOperationChange(toOperationError(err))
    } finally {
      setEditTitleBusy(false)
    }
  }

  async function handleDeleteTestCase(testId: string) {
    if (deleteBusy) return
    setDeleteBusy(true)
    try {
      await api.deleteTestCase(projectId, testId)
      setSelectedTestId(null)
      await reload()
    } catch (err) {
      onOperationChange(toOperationError(err))
    } finally {
      setDeleteBusy(false)
    }
  }

  async function handleImportLegacyTests() {
    if (!importFolderPath.trim() || importBusy) return
    setImportBusy(true)
    setImportError(null)
    setLastImportCount(null)
    try {
      const result = await api.importLegacyTestCases(projectId, importFolderPath.trim())
      setLastImportCount(result.imported.length)
      await reload()
    } catch (err) {
      setImportError(toOperationError(err).error ?? 'Failed to import legacy test cases.')
    } finally {
      setImportBusy(false)
    }
  }

  async function handleDeleteImportedTestCase(testId: string) {
    await api.deleteImportedTestCase(projectId, testId)
    setImportedTestCases((prev) => (prev ? { ...prev, tests: prev.tests.filter((t) => t.id !== testId) } : prev))
  }

  async function handleUnitTestModeChange(mode: ProjectSettings['unitTestMode']) {
    const updated = await api.updateProjectSettings(projectId, { unitTestMode: mode })
    onSettingsChange(updated)
  }

  async function handleChatSend() {
    if (!chatInput.trim() || chatBusy) return
    const message = chatInput.trim()
    setChatHistory((prev) => [...prev, { role: 'user', text: message }])
    setChatInput('')
    setChatBusy(true)
    setChatError(null)
    setChatErrorIsLlmNotConfigured(false)
    onOperationChange({ text: 'QA is thinking...' })
    try {
      const result = await api.testCreationChat(projectId, selectedElementId || null, message)
      setChatHistory((prev) => [...prev, { role: 'qa', text: result.reply }])
      setProposedTests((prev) => [...prev, ...result.proposedTests])
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

  async function handleAcceptTestProposal(proposal: ProposedTest) {
    await api.acceptProposedTest(projectId, proposal, selectedElementId || null)
    setProposedTests((prev) => prev.filter((p) => p !== proposal))
    await reload()
  }

  function handleDiscardTestProposal(proposal: ProposedTest) {
    setProposedTests((prev) => prev.filter((p) => p !== proposal))
  }

  const importSection = (
    <details className="test-creation-import-panel">
      <summary>Import legacy test cases from previous project</summary>
      <p className="test-creation-hint">
        Point at a folder of existing test files (*.test.ts, *.spec.ts, and similar) from an
        earlier or external project. Each file is analyzed and copied as-is into this project's
        source tree — imported tests are untraced (no requirement/interface link) and shown
        separately below; they don't count toward requirement status.
      </p>
      <div className="test-creation-import-bar">
        <input
          type="text"
          value={importFolderPath}
          onChange={(e) => setImportFolderPath(e.target.value)}
          placeholder="Path to a folder of test files..."
        />
        <button type="button" onClick={handleImportLegacyTests} disabled={importBusy || !importFolderPath.trim()}>
          {importBusy ? 'Analyzing...' : 'Analyze & Import'}
        </button>
      </div>
      {importError && <p className="test-creation-import-error">{importError}</p>}
      {lastImportCount !== null && (
        <p className="test-creation-hint">
          {lastImportCount === 0 ? 'No new test files found.' : `Imported ${lastImportCount} test case(s).`}
        </p>
      )}

      {importedTestCases && importedTestCases.tests.length > 0 && (
        <ul className="test-creation-imported-list">
          {importedTestCases.tests.map((t) => (
            <li key={t.id} className="test-creation-imported-row">
              <div className="test-creation-imported-row-header">
                <span className="test-creation-imported-badge">Untraced</span>
                <span className="test-creation-title">{t.title}</span>
                <button type="button" onClick={() => handleDeleteImportedTestCase(t.id)}>
                  Remove
                </button>
              </div>
              <p className="test-creation-hint">{t.description}</p>
              <p className="test-creation-filepath">{t.filePath}</p>
            </li>
          ))}
        </ul>
      )}
    </details>
  )

  if (loadError) {
    return (
      <div className="test-creation-screen">
        <h1>Test Creation</h1>
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
      <div className="test-creation-screen">
        <h1>Test Creation</h1>
        <p className="test-creation-hint">
          No architecture elements yet — add elements on the Architecture tab before creating tests.
        </p>
        {importSection}
      </div>
    )
  }

  return (
    <div className="test-creation-screen">
      <div className="test-creation-scope-note">
        <h1 className="test-creation-scope-note-title">Requirement-based test cases</h1>
        <p className="test-creation-hint">
          This tab creates test cases against the <strong>Requirement text only</strong> — every test case here
          must trace back to a requirement (functional tests) or an interface contract (integration tests). It
          does not run or generate the coding agent's own tests.
        </p>
      </div>

      <div className="test-creation-main-layout">
      <div className="test-creation-main-column">

      <div className="test-creation-section">
        {importSection}

        <div className="test-creation-settings-panel">
          <label className="test-creation-mode-label">
            Unit test generation mode
            <select
              value={settings.unitTestMode}
              onChange={(e) => handleUnitTestModeChange(e.target.value as ProjectSettings['unitTestMode'])}
            >
              <option value="llm">LLM</option>
              <option value="scaffold">Scaffold</option>
              <option value="disabled">Disabled</option>
            </select>
          </label>
          <p className="test-creation-hint">{UNIT_TEST_MODE_RATIONALE[settings.unitTestMode]}</p>
        </div>

        <div className="test-creation-action-bar">
        <select value={selectedElementId} onChange={(e) => setSelectedElementId(e.target.value)}>
          <option value="">Select an element...</option>
          {architecture.elements.map((e: ArchitectureElement) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
        <button type="button" onClick={handleGenerateFunctional} disabled={busy || !selectedElementId}>
          Generate Functional Tests
        </button>

        <select value={selectedPairKey} onChange={(e) => setSelectedPairKey(e.target.value)}>
          <option value="">Select a connection...</option>
          {connectedPairs.map((p) => (
            <option key={`${p.fromId}|${p.toId}`} value={`${p.fromId}|${p.toId}`}>
              {p.label}
            </option>
          ))}
        </select>
        <button type="button" onClick={handleGenerateIntegration} disabled={busy || !selectedPairKey}>
          Generate Integration Tests
        </button>

        <button type="button" onClick={handleGenerateAll} disabled={busy}>
          Generate All Test Cases
        </button>
        <button
          type="button"
          onClick={handleGenerateAllAutomations}
          disabled={busy || tests.every((t) => t.filePath)}
          title="Writes the test file for every test case that doesn't have one yet"
        >
          Generate All Test Case Automations
        </button>

        <button type="button" onClick={addFormOpen ? () => setAddFormOpen(false) : handleOpenAddForm} disabled={busy}>
          {addFormOpen ? 'Cancel' : 'Add Test Case'}
        </button>
        <button type="button" className="test-creation-secondary-button" onClick={expandAllGroups}>
          Expand All
        </button>
        <button type="button" className="test-creation-secondary-button" onClick={collapseAllGroups}>
          Collapse All
        </button>
      </div>

      {addFormOpen && (
        <div className="test-creation-add-form">
          <h2>Add test case</h2>
          <label className="test-creation-add-field">
            Type
            <select value={addType} onChange={(e) => setAddType(e.target.value as TestCase['type'])}>
              <option value="functional">Functional</option>
              <option value="integration">Integration</option>
            </select>
          </label>
          <label className="test-creation-add-field">
            Title
            <input
              type="text"
              value={addTitle}
              onChange={(e) => setAddTitle(e.target.value)}
              placeholder="What does this test verify?"
            />
          </label>

          {addType === 'functional' ? (
            <>
              <label className="test-creation-add-field">
                Architecture element
                <select value={addElementId} onChange={(e) => setAddElementId(e.target.value)}>
                  <option value="">Select an element...</option>
                  {architecture.elements.map((e: ArchitectureElement) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="test-creation-add-field">
                Requirements verified
                <div className="test-creation-add-requirement-list">
                  {requirements
                    .filter((r) => !addElementId || r.architectureElements.includes(addElementId))
                    .map((r) => (
                      <label key={r.id} className="test-creation-add-requirement-row">
                        <input
                          type="checkbox"
                          checked={addRequirementIds.includes(r.id)}
                          onChange={() => toggleAddRequirementId(r.id)}
                        />
                        <span>
                          {r.id}: {r.text}
                        </span>
                      </label>
                    ))}
                  {requirements.filter((r) => !addElementId || r.architectureElements.includes(addElementId)).length === 0 && (
                    <p className="test-creation-hint">
                      {addElementId
                        ? 'No requirements are allocated to this element yet.'
                        : 'Select an element to see its allocated requirements.'}
                    </p>
                  )}
                </div>
              </div>
            </>
          ) : (
            <label className="test-creation-add-field">
              Connection
              <select value={addPairKey} onChange={(e) => setAddPairKey(e.target.value)}>
                <option value="">Select a connection...</option>
                {connectedPairs.map((p) => (
                  <option key={`${p.fromId}|${p.toId}`} value={`${p.fromId}|${p.toId}`}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
          )}

          {addError && <p className="test-creation-import-error">{addError}</p>}

          <div className="test-creation-add-form-actions">
            <button type="button" onClick={handleAddTestCase} disabled={addBusy || !addTitle.trim()}>
              {addBusy ? 'Adding...' : 'Add'}
            </button>
            <button type="button" onClick={() => setAddFormOpen(false)} disabled={addBusy}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {rejected.length > 0 && (
        <div className="test-creation-rejected-banner">
          <strong>Rejected — not traceable to a requirement/contract:</strong>
          <ul>
            {rejected.map((r, i) => (
              <li key={i}>
                {r.title} — {r.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="test-creation-layout">
        <div className="test-creation-list">
          {tests.length === 0 && <p className="test-creation-hint">No tests yet.</p>}
          {testGroups.map((group) => {
            const generatedCount = group.tests.filter((t) => t.filePath).length
            const passingCount = group.tests.filter((t) => t.status === 'passing').length
            const failingCount = group.tests.filter((t) => t.status === 'failing').length
            const groupDotColor = failingCount > 0
              ? STATUS_COLOR.blocked
              : passingCount === group.tests.length
                ? STATUS_COLOR.complete
                : passingCount > 0 || generatedCount > 0
                  ? STATUS_COLOR['in-progress']
                  : STATUS_COLOR['not-started']
            const collapsed = collapsedGroups.has(group.scopeKey)

            return (
              <div key={group.scopeKey} className="test-creation-group">
                <div className="test-creation-group-header">
                  <button
                    type="button"
                    className="test-creation-group-toggle"
                    onClick={() => toggleGroupCollapsed(group.scopeKey)}
                    aria-label={collapsed ? `Expand ${group.label}` : `Collapse ${group.label}`}
                    aria-expanded={!collapsed}
                  >
                    {collapsed ? '▸' : '▾'}
                  </button>
                  <span className="test-creation-status-dot" style={{ background: groupDotColor }} />
                  <span className="test-creation-group-title">{group.label}</span>
                  <span className="test-creation-group-summary">
                    {generatedCount}/{group.tests.length} generated, {passingCount} passing
                  </span>
                </div>
                {!collapsed && (
                  <ul className="test-creation-group-list">
                    {group.tests.map((test) => (
                      <li
                        key={test.id}
                        className={test.id === selectedTestId ? 'test-creation-row test-creation-row-selected' : 'test-creation-row'}
                        onClick={() => setSelectedTestId(test.id)}
                      >
                        <span className="test-creation-status-dot" style={{ background: TEST_STATUS_COLOR[test.status] }} />
                        <span className="test-creation-title">{test.title}</span>
                        <span className="test-creation-type-badge">{test.type}</span>
                        <span
                          className={test.filePath ? 'test-creation-generation-badge' : 'test-creation-generation-badge test-creation-generation-badge-pending'}
                        >
                          {test.filePath ? 'Generated' : 'Not generated'}
                        </span>
                        <span className="test-creation-status-badge" style={{ background: TEST_STATUS_COLOR[test.status] }}>
                          {TEST_STATUS_LABEL[test.status]}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )
          })}
        </div>

        <div className="test-creation-detail-pane">
          {!selectedTest ? (
            <p className="test-creation-hint">Select a test to view its detail.</p>
          ) : (
            <>
              <div className="test-creation-detail-header">
                <input
                  key={selectedTest.id}
                  type="text"
                  className="test-creation-title-input"
                  value={editTitleValue}
                  onChange={(e) => setEditTitleValue(e.target.value)}
                  onBlur={() => {
                    if (editTitleValue.trim() && editTitleValue.trim() !== selectedTest.title) {
                      handleSaveTitle(selectedTest.id)
                    } else {
                      setEditTitleValue(selectedTest.title)
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  }}
                  disabled={editTitleBusy}
                />
                <div className="test-creation-detail-header-actions">
                  <button type="button" onClick={() => handleGenerateFile(selectedTest.id)} disabled={busy}>
                    Generate Test File
                  </button>
                  <button
                    type="button"
                    className="test-creation-delete-button"
                    onClick={() => handleDeleteTestCase(selectedTest.id)}
                    disabled={deleteBusy}
                  >
                    Delete
                  </button>
                </div>
              </div>
              <div className="test-creation-detail-badges">
                <span
                  className={
                    selectedTest.filePath
                      ? 'test-creation-generation-badge'
                      : 'test-creation-generation-badge test-creation-generation-badge-pending'
                  }
                >
                  {selectedTest.filePath ? 'Generated' : 'Not generated'}
                </span>
                <span className="test-creation-status-badge" style={{ background: TEST_STATUS_COLOR[selectedTest.status] }}>
                  {TEST_STATUS_LABEL[selectedTest.status]}
                </span>
              </div>
              <p className="test-creation-hint">
                {selectedTest.type === 'functional'
                  ? `Verifies: ${selectedTest.requirementIds.join(', ') || '(none)'}`
                  : `Verifies interface: ${selectedTest.interfaceElementIds?.[0]} <-> ${selectedTest.interfaceElementIds?.[1]}`}
              </p>
              {selectedTest.filePath ? (
                <p className="test-creation-filepath">{selectedTest.filePath}</p>
              ) : (
                <p className="test-creation-hint">No test file generated yet.</p>
              )}

              {lastGenerateResult && (
                <>
                  {lastGenerateResult.status !== 'success' && (
                    <div className="test-creation-run-banner">
                      {lastGenerateResult.status === 'rejected-scope' && (
                        <>
                          The CLI wrote outside its allowed scope — those changes were reverted.
                          {lastGenerateResult.rejectedFiles && lastGenerateResult.rejectedFiles.length > 0 && (
                            <ul>
                              {lastGenerateResult.rejectedFiles.map((f) => (
                                <li key={f}>{f}</li>
                              ))}
                            </ul>
                          )}
                        </>
                      )}
                      {lastGenerateResult.status === 'cli-error' && 'The Claude Code CLI run failed. See the raw log below.'}
                    </div>
                  )}
                  <details className="test-creation-raw-log">
                    <summary>Raw output</summary>
                    <pre>{lastGenerateResult.rawLog}</pre>
                  </details>
                </>
              )}
            </>
          )}
        </div>
      </div>
      </div>

      </div>

      <div className="test-creation-llm-panel">
        <div className="analyst-chat-panel">
          <div className="analyst-chat-heading-row">
            <h2>LLM output</h2>
            <span className="analyst-chat-hint">
              Ask QA to help think through what tests the selected element needs — every reply, proposal, and
              in-progress file update from this tab appears here.
            </span>
          </div>
          <div className={`analyst-chat-history ${chatHistory.length === 0 ? 'analyst-chat-history-empty' : ''}`}>
            {chatHistory.length === 0 && !chatBusy && (
              <p className="analyst-chat-empty">No messages yet — start the conversation below.</p>
            )}
            {chatHistory.map((entry, i) => (
              <div key={i} className={`analyst-chat-entry analyst-chat-entry-${entry.role}`}>
                <strong>{entry.role === 'user' ? 'You' : 'QA'}</strong>
                <p>{highlightRequirementIds(entry.text)}</p>
              </div>
            ))}
            {chatBusy && <p className="analyst-chat-empty">QA is thinking...</p>}

            {lastGenerateResult && (
              <div className="analyst-chat-entry analyst-chat-entry-qa">
                <strong>File generation</strong>
                {lastGenerateResult.status !== 'success' && (
                  <div className="test-creation-run-banner">
                    {lastGenerateResult.status === 'rejected-scope' && (
                      <>
                        The CLI wrote outside its allowed scope — those changes were reverted.
                        {lastGenerateResult.rejectedFiles && lastGenerateResult.rejectedFiles.length > 0 && (
                          <ul>
                            {lastGenerateResult.rejectedFiles.map((f) => (
                              <li key={f}>{f}</li>
                            ))}
                          </ul>
                        )}
                      </>
                    )}
                    {lastGenerateResult.status === 'cli-error' && 'The Claude Code CLI run failed. See the raw log below.'}
                  </div>
                )}
                <details className="test-creation-raw-log" open>
                  <summary>Raw output</summary>
                  <pre>{lastGenerateResult.rawLog}</pre>
                </details>
              </div>
            )}
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

          {proposedTests.length > 0 && (
            <div className="analyst-chat-proposals">
              <h3>Proposed tests</h3>
              {proposedTests.map((proposal, i) => (
                <div key={`${proposal.title}-${i}`} className="analyst-chat-proposal">
                  <p>
                    <strong>{proposal.title}</strong> — verifies {proposal.requirementIds.join(', ') || '(no requirements named)'}
                  </p>
                  <div className="analyst-chat-proposal-actions">
                    <button type="button" onClick={() => handleAcceptTestProposal(proposal)}>
                      Accept
                    </button>
                    <button type="button" onClick={() => handleDiscardTestProposal(proposal)}>
                      Discard
                    </button>
                  </div>
                </div>
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
              placeholder="Ask QA..."
              rows={2}
            />
            <button type="button" onClick={handleChatSend} disabled={!chatInput.trim() || chatBusy}>
              Send
            </button>
          </div>
        </div>
      </div>

      </div>
    </div>
  )
}
