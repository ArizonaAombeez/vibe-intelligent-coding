import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  Architecture,
  CurrentOperation,
  Requirement,
  TestCase,
  TestCommandScope,
  TestRegressionRun,
  TestRun,
  TestSuite,
  VicCoreApi,
} from '../api/types'
import { toOperationError } from '../api/errorCode'
import { STATUS_COLOR } from '../statusColor'
import { highlightRequirementIds } from './requirementIdHighlight'
import './RequirementsScreen.css'
import './TestExecutionScreen.css'

interface TestExecutionScreenProps {
  api: VicCoreApi
  projectId: string
  onOperationChange: (op: CurrentOperation) => void
  onOpenSettings: () => void
}

interface TestExecutionChatEntry {
  role: 'user' | 'qa'
  text: string
}

const DEFAULT_CHAT_HEIGHT = 260
const MIN_CHAT_HEIGHT = 120
const MAX_CHAT_HEIGHT = 640

const TRIAGE_LABEL: Record<NonNullable<TestRun['outcomes'][number]['triage']>, string> = {
  'code-failure': 'Code failure',
  'test-case-failure': 'Test case failure — needs review',
  unattributed: 'Unattributed',
}

function scopeForTest(test: TestCase): TestCommandScope {
  return test.interfaceElementIds
    ? { interfaceElementIds: test.interfaceElementIds }
    : { architectureElementId: test.architectureElementId! }
}

// Identifies the element/interface-pair a test's command actually runs at
// (the real execution granularity — see runElementTestSuite), used to group
// the list and to dedupe scopes when running a multi-element selection.
function scopeKeyForTest(test: TestCase): string {
  return test.interfaceElementIds ? `if:${[...test.interfaceElementIds].sort().join('|')}` : `el:${test.architectureElementId}`
}

function scopeLabel(test: TestCase, architecture: Architecture): string {
  if (test.interfaceElementIds) {
    const [fromId, toId] = test.interfaceElementIds
    const fromName = architecture.elements.find((e) => e.id === fromId)?.name ?? fromId
    const toName = architecture.elements.find((e) => e.id === toId)?.name ?? toId
    return `${fromName} ↔ ${toName}`
  }
  return architecture.elements.find((e) => e.id === test.architectureElementId)?.name ?? 'Unassigned'
}

function latestRunForTest(runs: TestRun[], testId: string): { run: TestRun; outcome: TestRun['outcomes'][number] } | null {
  const candidates = runs
    .filter((r) => r.outcomes.some((o) => o.testCaseId === testId))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  const run = candidates[0]
  if (!run) return null
  const outcome = run.outcomes.find((o) => o.testCaseId === testId)!
  return { run, outcome }
}

interface TestGroup {
  scopeKey: string
  label: string
  scope: TestCommandScope
  tests: TestCase[]
}

function groupTestsByScope(tests: TestCase[], architecture: Architecture): TestGroup[] {
  const groups = new Map<string, TestGroup>()
  for (const test of tests) {
    const scopeKey = scopeKeyForTest(test)
    let group = groups.get(scopeKey)
    if (!group) {
      group = { scopeKey, label: scopeLabel(test, architecture), scope: scopeForTest(test), tests: [] }
      groups.set(scopeKey, group)
    }
    group.tests.push(test)
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label))
}

export function TestExecutionScreen({ api, projectId, onOperationChange, onOpenSettings }: TestExecutionScreenProps) {
  const [testSuite, setTestSuite] = useState<TestSuite | null>(null)
  const [architecture, setArchitecture] = useState<Architecture | null>(null)
  const [runs, setRuns] = useState<TestRun[]>([])
  const [regressionRuns, setRegressionRuns] = useState<TestRegressionRun[]>([])
  const [requirements, setRequirements] = useState<Requirement[]>([])
  const [selectedTestId, setSelectedTestId] = useState<string | null>(null)
  const [checkedTestIds, setCheckedTestIds] = useState<Set<string>>(new Set())
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const collapsedGroupsInitialized = useRef(false)
  const [busy, setBusy] = useState(false)
  const [runStatusText, setRunStatusText] = useState<string | null>(null)
  const [commandDraft, setCommandDraft] = useState('')
  const [argsDraft, setArgsDraft] = useState('')

  const [chatHistory, setChatHistory] = useState<TestExecutionChatEntry[]>([])
  const [chatInput, setChatInput] = useState('')
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
    const [suite, arch, allRuns, allRegressionRuns, allRequirements] = await Promise.all([
      api.getTestSuite(projectId),
      api.getArchitecture(projectId),
      api.listTestRuns(projectId),
      api.listTestRegressionRuns(projectId),
      api.listRequirements(projectId),
    ])
    setTestSuite(suite)
    setArchitecture(arch)
    setRuns(allRuns)
    setRegressionRuns(allRegressionRuns)
    setRequirements(allRequirements)
  }

  useEffect(() => {
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, projectId])

  const tests = (testSuite?.tests ?? []).filter((t) => !t.deletedAt)
  const selectedTest = tests.find((t) => t.id === selectedTestId) ?? null
  const latest = selectedTest ? latestRunForTest(runs, selectedTest.id) : null
  const groups = architecture ? groupTestsByScope(tests, architecture) : []
  const checkedCount = checkedTestIds.size

  const latestRegression = [...regressionRuns].sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))[0] ?? null
  const awaitingRegressionCount = requirements.filter((r) => !r.deletedAt && r.status === 'tested').length

  const runHistory = [
    ...runs.map((r) => ({
      id: r.id,
      kind: r.kind === 'full-regression' ? ('regression' as const) : ('element' as const),
      finishedAt: r.finishedAt,
      passed: r.outcomes.filter((o) => o.passed).length,
      total: r.outcomes.length,
      label:
        r.kind === 'full-regression'
          ? 'Full regression'
          : r.interfaceElementIds
            ? 'Interface run'
            : (architecture?.elements.find((e) => e.id === r.architectureElementId)?.name ?? 'Element run'),
    })),
  ].sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))

  useEffect(() => {
    if (collapsedGroupsInitialized.current || groups.length === 0) return
    collapsedGroupsInitialized.current = true
    setCollapsedGroups(new Set(groups.map((g) => g.scopeKey)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups.length])

  function expandAllGroups() {
    setCollapsedGroups(new Set())
  }

  function collapseAllGroups() {
    setCollapsedGroups(new Set(groups.map((g) => g.scopeKey)))
  }

  function toggleTest(testId: string) {
    setCheckedTestIds((prev) => {
      const next = new Set(prev)
      if (next.has(testId)) next.delete(testId)
      else next.add(testId)
      return next
    })
  }

  function toggleGroup(group: TestGroup) {
    const allChecked = group.tests.every((t) => checkedTestIds.has(t.id))
    setCheckedTestIds((prev) => {
      const next = new Set(prev)
      for (const t of group.tests) {
        if (allChecked) next.delete(t.id)
        else next.add(t.id)
      }
      return next
    })
  }

  function toggleGroupCollapsed(scopeKey: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(scopeKey)) next.delete(scopeKey)
      else next.add(scopeKey)
      return next
    })
  }

  useEffect(() => {
    if (!selectedTest) return
    api.getTestCommand(projectId, scopeForTest(selectedTest)).then((cmd) => {
      setCommandDraft(cmd.command)
      setArgsDraft(cmd.args.join(' '))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTest?.id])

  async function withBusyAction(text: string, action: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    setRunStatusText(text)
    onOperationChange({ text })
    try {
      await action()
      setRunStatusText('Done.')
      onOperationChange({ text: null })
    } catch (err) {
      setRunStatusText('Failed — see status bar for details.')
      onOperationChange(toOperationError(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleRunTests(test: TestCase) {
    await withBusyAction(`Running tests for ${scopeLabel(test, architecture!)}...`, async () => {
      await api.runElementTests(projectId, scopeForTest(test))
      await reload()
    })
  }

  async function handleRunGroup(group: TestGroup) {
    await withBusyAction(`Running ${group.tests.length} test(s) for ${group.label}...`, async () => {
      await api.runElementTests(projectId, group.scope)
      await reload()
    })
  }

  async function handleRunSelected() {
    if (checkedTestIds.size === 0 || !architecture) return
    const selectedTests = tests.filter((t) => checkedTestIds.has(t.id))
    const touchedGroups = groupTestsByScope(selectedTests, architecture)
    await withBusyAction(`Running ${checkedTestIds.size} selected test(s) across ${touchedGroups.length} element(s)...`, async () => {
      for (let i = 0; i < touchedGroups.length; i++) {
        setRunStatusText(`Running ${touchedGroups[i].label} (${i + 1}/${touchedGroups.length})...`)
        onOperationChange({ text: `Running ${touchedGroups[i].label} (${i + 1}/${touchedGroups.length})...` })
        await api.runElementTests(projectId, touchedGroups[i].scope)
      }
      await reload()
    })
  }

  async function handleRunRegression() {
    await withBusyAction('Running full regression...', async () => {
      await api.runFullRegression(projectId)
      await reload()
    })
  }

  async function handleTriage() {
    if (!latest) return
    await withBusyAction('QA is triaging the failing test...', async () => {
      await api.triageTestFailure(projectId, latest.run.id, latest.outcome.testCaseId)
      await reload()
    })
  }

  async function handleConfirm() {
    if (!latest) return
    await withBusyAction('Confirming test-case-failure...', async () => {
      await api.confirmTestCaseFailure(projectId, latest.run.id, latest.outcome.testCaseId)
      await reload()
    })
  }

  async function handleSaveCommand() {
    if (!selectedTest) return
    await api.setTestCommand(projectId, scopeForTest(selectedTest), commandDraft, argsDraft.split(' ').filter(Boolean))
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
      const result = await api.testExecutionChat(projectId, selectedTest?.id ?? null, latest?.run.id ?? null, message)
      setChatHistory((prev) => [...prev, { role: 'qa', text: result.reply }])
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

  if (!architecture || tests.length === 0) {
    return (
      <div className="test-execution-screen">
        <h1>Test Execution</h1>
        <p className="test-execution-hint">No tests yet — create tests on the Test Creation tab first.</p>
      </div>
    )
  }

  return (
    <div className="test-execution-screen">
      <h1>Test Execution</h1>

      <div className="test-execution-action-bar">
        <button type="button" onClick={handleRunRegression} disabled={busy}>
          Run Regression
        </button>
        <button type="button" onClick={handleRunSelected} disabled={busy || checkedCount === 0}>
          Run Selected{checkedCount > 0 ? ` (${checkedCount})` : ''}
        </button>
        <button type="button" className="test-execution-secondary-button" onClick={expandAllGroups}>
          Expand All
        </button>
        <button type="button" className="test-execution-secondary-button" onClick={collapseAllGroups}>
          Collapse All
        </button>
        {(busy || runStatusText) && (
          <span className="test-execution-status-text" aria-live="polite">
            {runStatusText}
          </span>
        )}
      </div>

      <div
        className={
          !latestRegression
            ? 'test-execution-regression-status tone-neutral'
            : latestRegression.allPassed
              ? 'test-execution-regression-status tone-good'
              : 'test-execution-regression-status tone-critical'
        }
      >
        <span className="test-execution-status-dot" />
        <span className="test-execution-regression-status-text">
          {!latestRegression
            ? 'No full regression run yet'
            : latestRegression.allPassed
              ? `Last full regression passed — ${new Date(latestRegression.finishedAt).toLocaleString()} (${latestRegression.trigger})`
              : `Last full regression FAILED — ${new Date(latestRegression.finishedAt).toLocaleString()} (${latestRegression.trigger})`}
        </span>
        {awaitingRegressionCount > 0 && (
          <span className="test-execution-regression-awaiting">
            {awaitingRegressionCount} requirement{awaitingRegressionCount === 1 ? '' : 's'} tested and awaiting regression to reach Complete
          </span>
        )}
      </div>

      <div className="test-execution-layout">
        <div className="test-execution-list">
          {groups.map((group) => {
            const groupOutcomes = group.tests.map((t) => latestRunForTest(runs, t.id)?.outcome)
            const anyRun = groupOutcomes.some(Boolean)
            const allPassed = anyRun && groupOutcomes.every((o) => o && o.passed)
            const anyFailed = groupOutcomes.some((o) => o && !o.passed)
            const groupDotColor = !anyRun
              ? STATUS_COLOR['not-started']
              : anyFailed
                ? STATUS_COLOR.blocked
                : allPassed
                  ? STATUS_COLOR.complete
                  : STATUS_COLOR['in-progress']
            const allChecked = group.tests.every((t) => checkedTestIds.has(t.id))
            const someChecked = !allChecked && group.tests.some((t) => checkedTestIds.has(t.id))
            const passedCount = groupOutcomes.filter((o) => o && o.passed).length
            const ranCount = groupOutcomes.filter(Boolean).length
            const collapsed = collapsedGroups.has(group.scopeKey)

            return (
              <div key={group.scopeKey} className="test-execution-group">
                <div className="test-execution-group-header">
                  <button
                    type="button"
                    className="test-execution-group-toggle"
                    onClick={() => toggleGroupCollapsed(group.scopeKey)}
                    aria-label={collapsed ? `Expand ${group.label}` : `Collapse ${group.label}`}
                    aria-expanded={!collapsed}
                  >
                    {collapsed ? '▸' : '▾'}
                  </button>
                  <input
                    type="checkbox"
                    checked={allChecked}
                    ref={(el) => {
                      if (el) el.indeterminate = someChecked
                    }}
                    onChange={() => toggleGroup(group)}
                    aria-label={`Select all tests for ${group.label}`}
                  />
                  <span className="test-execution-status-dot" style={{ background: groupDotColor }} />
                  <span className="test-execution-group-title">{group.label}</span>
                  <span className="test-execution-group-summary">
                    {ranCount === 0 ? `${group.tests.length} not run` : `${passedCount}/${ranCount} passed, ${group.tests.length} total`}
                  </span>
                  <button type="button" className="test-execution-group-run" onClick={() => handleRunGroup(group)} disabled={busy}>
                    Run Group
                  </button>
                </div>
                {!collapsed && (
                  <ul className="test-execution-group-list">
                    {group.tests.map((test) => {
                      const found = latestRunForTest(runs, test.id)
                      const outcome = found?.outcome
                      const dotColor = !outcome ? STATUS_COLOR['not-started'] : outcome.passed ? STATUS_COLOR.complete : STATUS_COLOR.blocked
                      return (
                        <li
                          key={test.id}
                          className={test.id === selectedTestId ? 'test-execution-row test-execution-row-selected' : 'test-execution-row'}
                        >
                          <input
                            type="checkbox"
                            checked={checkedTestIds.has(test.id)}
                            onChange={() => toggleTest(test.id)}
                            onClick={(e) => e.stopPropagation()}
                            aria-label={`Select ${test.title}`}
                          />
                          <span className="test-execution-row-body" onClick={() => setSelectedTestId(test.id)}>
                            <span className="test-execution-status-dot" style={{ background: dotColor }} />
                            <span className="test-execution-title">{test.title}</span>
                            <span className="test-execution-run-state">
                              {!outcome ? 'Not run' : outcome.passed ? 'Passed' : 'Failed'}
                            </span>
                            {outcome && !outcome.passed && (
                              <span className="test-execution-triage-badge">{TRIAGE_LABEL[outcome.triage ?? 'unattributed']}</span>
                            )}
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            )
          })}
        </div>

        <div className="test-execution-detail-pane">
          {!selectedTest ? (
            <p className="test-execution-hint">Select a test to view its detail.</p>
          ) : (
            <>
              <div className="test-execution-detail-header">
                <h2>{selectedTest.title}</h2>
                <button type="button" onClick={() => handleRunTests(selectedTest)} disabled={busy}>
                  Run Tests
                </button>
              </div>

              <div className="test-execution-command-row">
                <label>
                  Command
                  <input value={commandDraft} onChange={(e) => setCommandDraft(e.target.value)} />
                </label>
                <label>
                  Args
                  <input value={argsDraft} onChange={(e) => setArgsDraft(e.target.value)} placeholder="space-separated" />
                </label>
                <button type="button" onClick={handleSaveCommand} disabled={busy}>
                  Save
                </button>
              </div>

              {!latest ? (
                <p className="test-execution-hint">No test run yet for this test.</p>
              ) : (
                <>
                  <p className="test-execution-hint">
                    Last run: {latest.outcome.passed ? 'passed' : 'failed'} ({latest.run.startedAt})
                  </p>
                  {!latest.outcome.passed && (
                    <div className="test-execution-triage-panel">
                      <p>
                        Triage: {TRIAGE_LABEL[latest.outcome.triage ?? 'unattributed']}
                        {latest.outcome.triageRationale && ` — ${latest.outcome.triageRationale}`}
                      </p>
                      {(!latest.outcome.triage || latest.outcome.triage === 'unattributed') && (
                        <button type="button" onClick={handleTriage} disabled={busy}>
                          Run Triage
                        </button>
                      )}
                      {latest.outcome.triage === 'test-case-failure' && !latest.outcome.testCaseFailureConfirmedAt && (
                        <button type="button" onClick={handleConfirm} disabled={busy}>
                          Confirm &amp; proceed
                        </button>
                      )}
                    </div>
                  )}
                  {latest.run.mutationScore ? (
                    <p className="test-execution-hint">Mutation score: {latest.run.mutationScore.percentage}%</p>
                  ) : (
                    <p className="test-execution-hint">Mutation score: Not run</p>
                  )}
                  <details className="test-execution-raw-log">
                    <summary>Raw output</summary>
                    <pre>{latest.run.rawLog}</pre>
                  </details>
                </>
              )}
            </>
          )}
        </div>

        <div className="test-execution-history-pane">
          <h2>Run History</h2>
          {runHistory.length === 0 ? (
            <p className="test-execution-hint">No runs yet.</p>
          ) : (
            <ul className="test-execution-history-list">
              {runHistory.map((run) => {
                const allPassed = run.total > 0 && run.passed === run.total
                const tone = run.total === 0 ? 'neutral' : allPassed ? 'good' : 'critical'
                return (
                  <li key={run.id} className={`test-execution-history-row tone-${tone}`}>
                    <span className="test-execution-status-dot" />
                    <span className="test-execution-history-label">
                      {run.kind === 'regression' ? 'Full regression' : run.label}
                    </span>
                    <span className="test-execution-history-count">
                      {run.passed}/{run.total} passed
                    </span>
                    <span className="test-execution-history-time">{new Date(run.finishedAt).toLocaleTimeString()}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>

      <div className="analyst-chat-dock" style={{ height: chatHeight }}>
        <div className="analyst-chat-resize-handle" onMouseDown={handleResizeStart} />
        <div className="analyst-chat-panel">
          <div className="analyst-chat-heading-row">
            <h2>QA chat</h2>
            <span className="analyst-chat-hint">
              Ask QA to help interpret a run's output or discuss why a test might be failing.
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
  )
}
