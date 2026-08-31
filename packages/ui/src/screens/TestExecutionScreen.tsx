import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  Architecture,
  ChatMessageLink,
  CurrentOperation,
  Requirement,
  ScopeReadiness,
  ScopeReadinessEntry,
  SwTestOutcome,
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
import { ChatDock } from '../components/ChatDock'
import type { PendingChatNav } from '../navigation/chatLinkNav'
import './RequirementsScreen.css'
import './TestExecutionScreen.css'
import '../components/Tooltip.css'

interface TestExecutionScreenProps {
  api: VicCoreApi
  projectId: string
  onOperationChange: (op: CurrentOperation) => void
  onOpenSettings: () => void
  onChatNavigate: (link: ChatMessageLink) => void
  pendingChatNav: PendingChatNav | null
  onChatNavConsumed: () => void
}

const TRIAGE_LABEL: Record<NonNullable<TestRun['outcomes'][number]['triage']>, string> = {
  'code-failure': 'Code failure',
  'test-case-failure': 'Test case failure — needs review',
  'requirement-issue': 'Requirement issue',
  unattributed: 'Not yet triaged',
}

type NotReadyReason = Extract<ScopeReadiness, { ready: false }>['reason']

const NOT_READY_REASON_LABEL: Record<NotReadyReason, string> = {
  'element-not-coded': 'This element has not been coded yet — run Step 5 Coding for it before running its tests.',
  'interface-element-not-coded': 'One or both elements on this interface have not been coded yet — run Step 5 Coding for them before running this test.',
}

// TS control-flow analysis doesn't reliably narrow `!x.ready` on a
// `Map.get()` result whose value is a boolean-discriminated union widened
// through undefined — spell the check out.
function notReadyReasonLabel(readiness: ScopeReadiness | undefined): string | null {
  if (!readiness || readiness.ready) return null
  return NOT_READY_REASON_LABEL[readiness.reason]
}

// Explains what a requirement-based test case needs next, for the row's
// hover tooltip — mirrors the same states the triage panel below the list
// already surfaces, so hovering tells the reader the same thing opening the
// test would.
function testRowTooltip(outcome: TestRun['outcomes'][number] | undefined): string {
  if (!outcome) return 'Not run yet — click to select, then Run Tests to execute it.'
  if (outcome.passed) return 'Passed on its last run — click to view details, or re-run to verify again.'
  if (!outcome.triage || outcome.triage === 'unattributed') {
    return 'Failed and not yet triaged — open this test and run Triage to find out whether the code or the test case is at fault.'
  }
  if (outcome.triage === 'test-case-failure' && !outcome.testCaseFailureConfirmedAt) {
    return 'Triaged as a test-case failure — open this test and confirm to proceed.'
  }
  if (outcome.triage === 'test-case-failure') {
    return 'Confirmed test-case failure — the test case itself needs to be fixed.'
  }
  if (outcome.triage === 'requirement-issue') {
    return 'Triaged as a requirement issue — the requirement has been amended; the code needs to be re-coded and this test re-run.'
  }
  return 'Triaged as a code failure — the code needs to be fixed and this test re-run.'
}

function swOutcomeTooltip(outcome: SwTestOutcome): string {
  return outcome.passed ? 'Passed on its last run.' : 'Failed on its last run — open this element to view the raw output.'
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

// True when the most recent run that touched this test's scope found its
// recorded file missing from disk (source tree re-coded, generated test
// file lost) and reset it. Distinct from "never generated": the test WAS
// generated once and needs regenerating, not authoring from scratch.
function fileMissingForTest(runs: TestRun[], testId: string): boolean {
  const withMissing = runs
    .filter((r) => (r.missingFiles ?? []).some((m) => m.testCaseId === testId))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  const latestMissing = withMissing[0]
  if (!latestMissing) return false
  // A later run that produced a real outcome for this test supersedes the
  // stale "missing" record (the file was regenerated since).
  const latestOutcome = latestRunForTest(runs, testId)
  return !latestOutcome || latestOutcome.run.startedAt <= latestMissing.startedAt
}

// T1.5(b): most recent run whose SCOPE covers this test but which produced
// NO outcome for it — i.e. the test's scope was executed and this test
// simply never ran (no generated file, or a file the runner can't match).
// Without this, such a run is invisible: latestRunForTest filters on
// r.outcomes.some(...), so a zero-outcome run matches nothing and the row
// renders "Not run", identical to never-attempted, with the explanatory
// rawLog unreachable.
function attemptedWithoutOutcome(runs: TestRun[], test: TestCase): TestRun | null {
  const scopeKey = scopeKeyForTest(test)
  const scoped = runs
    .filter((r) => {
      const key = r.interfaceElementIds
        ? `if:${[...r.interfaceElementIds].sort().join('|')}`
        : `el:${r.architectureElementId}`
      return key === scopeKey
    })
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  const latestScopeRun = scoped[0]
  if (!latestScopeRun) return null
  if (latestScopeRun.outcomes.some((o) => o.testCaseId === test.id)) return null
  // A later real outcome supersedes it.
  const latestOutcome = latestRunForTest(runs, test.id)
  if (latestOutcome && latestOutcome.run.startedAt > latestScopeRun.startedAt) return null
  return latestScopeRun
}

// Most recent element-scoped TestRun for a given scope, regardless of
// whether it carried any requirement-traced outcomes — used to surface
// SW-based (coding-agent) test results, which have no TestCase id and so
// can't be found via latestRunForTest above.
function latestRunForScope(runs: TestRun[], scope: TestCommandScope): TestRun | null {
  const candidates = runs
    .filter((r) => {
      if ('interfaceElementIds' in scope) {
        const key = [...scope.interfaceElementIds].sort().join('|')
        return r.interfaceElementIds && [...r.interfaceElementIds].sort().join('|') === key
      }
      return r.architectureElementId === scope.architectureElementId
    })
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  return candidates[0] ?? null
}

interface TestGroup {
  scopeKey: string
  label: string
  scope: TestCommandScope
  tests: TestCase[]
}

function seedScopeGroups(architecture: Architecture): Map<string, TestGroup> {
  const groups = new Map<string, TestGroup>()

  // Seed one group per architecture element (and connected pair) up front —
  // an element with no requirement-based TestCases yet still needs its own
  // group so its SW-based (coding-agent) test results have somewhere to
  // show and a Run Group button of their own.
  for (const element of architecture.elements) {
    const scopeKey = `el:${element.id}`
    groups.set(scopeKey, {
      scopeKey,
      label: element.name,
      scope: { architectureElementId: element.id },
      tests: [],
    })
  }
  for (const element of architecture.elements) {
    for (const toId of element.interfaces) {
      const key = [...[element.id, toId]].sort().join('|')
      const scopeKey = `if:${key}`
      if (groups.has(scopeKey)) continue
      const fromName = architecture.elements.find((e) => e.id === element.id)?.name ?? element.id
      const toName = architecture.elements.find((e) => e.id === toId)?.name ?? toId
      groups.set(scopeKey, {
        scopeKey,
        label: `${fromName} ↔ ${toName}`,
        scope: { interfaceElementIds: [element.id, toId] },
        tests: [],
      })
    }
  }
  return groups
}

function groupTestsByScope(tests: TestCase[], architecture: Architecture): TestGroup[] {
  const groups = seedScopeGroups(architecture)

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

interface SwTestGroup {
  scopeKey: string
  label: string
  scope: TestCommandScope
  outcomes: SwTestOutcome[]
  run: TestRun | null
}

// Mirrors groupTestsByScope but for SW-based (coding-agent) tests — these
// have no TestCase id, so grouping/lookup is purely by scope + the most
// recent TestRun's swOutcomes for that scope.
function groupSwTestsByScope(runs: TestRun[], architecture: Architecture): SwTestGroup[] {
  const scopeGroups = seedScopeGroups(architecture)
  const result: SwTestGroup[] = []
  for (const group of scopeGroups.values()) {
    const run = latestRunForScope(runs, group.scope)
    result.push({
      scopeKey: group.scopeKey,
      label: group.label,
      scope: group.scope,
      outcomes: run?.swOutcomes ?? [],
      run,
    })
  }
  return result.sort((a, b) => a.label.localeCompare(b.label))
}

export function TestExecutionScreen({
  api,
  projectId,
  onOperationChange,
  onOpenSettings,
  onChatNavigate,
  pendingChatNav,
  onChatNavConsumed,
}: TestExecutionScreenProps) {
  const [testSuite, setTestSuite] = useState<TestSuite | null>(null)
  const [architecture, setArchitecture] = useState<Architecture | null>(null)
  const [runs, setRuns] = useState<TestRun[]>([])
  const [regressionRuns, setRegressionRuns] = useState<TestRegressionRun[]>([])
  const [requirements, setRequirements] = useState<Requirement[]>([])
  const [readinessEntries, setReadinessEntries] = useState<ScopeReadinessEntry[]>([])
  const [selectedTestId, setSelectedTestId] = useState<string | null>(null)
  const [selectedSwScopeKey, setSelectedSwScopeKey] = useState<string | null>(null)
  const [checkedTestIds, setCheckedTestIds] = useState<Set<string>>(new Set())
  const [checkedSwScopeKeys, setCheckedSwScopeKeys] = useState<Set<string>>(new Set())
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [collapsedSwGroups, setCollapsedSwGroups] = useState<Set<string>>(new Set())
  const collapsedGroupsInitialized = useRef(false)
  const [busy, setBusy] = useState(false)
  const [, setRunStatusText] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)


  async function reload() {
    const [suite, arch, allRuns, allRegressionRuns, allRequirements, readiness] = await Promise.all([
      api.getTestSuite(projectId),
      api.getArchitecture(projectId),
      api.listTestRuns(projectId),
      api.listTestRegressionRuns(projectId),
      api.listRequirements(projectId),
      api.getTestScopeReadiness(projectId),
    ])
    setTestSuite(suite)
    setArchitecture(arch)
    setRuns(allRuns)
    setRegressionRuns(allRegressionRuns)
    setRequirements(allRequirements)
    setReadinessEntries(readiness)
  }

  useEffect(() => {
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, projectId])

  const tests = (testSuite?.tests ?? []).filter((t) => !t.deletedAt)
  const selectedTest = tests.find((t) => t.id === selectedTestId) ?? null
  const latest = selectedTest ? latestRunForTest(runs, selectedTest.id) : null
  const groups = architecture ? groupTestsByScope(tests, architecture) : []
  const swGroups = architecture ? groupSwTestsByScope(runs, architecture) : []
  const selectedSwGroup = swGroups.find((g) => g.scopeKey === selectedSwScopeKey) ?? null
  const checkedCount = checkedTestIds.size
  const readinessByScopeKey = new Map<string, ScopeReadiness>(
    readinessEntries.map((e) => [e.scopeKey, e.readiness]),
  )
  const isScopeReady = (scopeKey: string) => readinessByScopeKey.get(scopeKey)?.ready !== false
  const readyGroups = groups.filter((g) => isScopeReady(g.scopeKey))
  const notReadyGroups = groups.filter((g) => !isScopeReady(g.scopeKey))
  const notReadyTestCount = notReadyGroups.reduce((sum, g) => sum + g.tests.length, 0)
  const checkedSwCount = checkedSwScopeKeys.size

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

  function selectAllTests() {
    setCheckedTestIds(new Set(tests.map((t) => t.id)))
  }

  function unselectAllTests() {
    setCheckedTestIds(new Set())
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

  function expandAllGroups() {
    setCollapsedGroups(new Set())
  }

  function collapseAllGroups() {
    setCollapsedGroups(new Set(groups.map((g) => g.scopeKey)))
  }

  function selectAllSwGroups() {
    setCheckedSwScopeKeys(new Set(swGroups.map((g) => g.scopeKey)))
  }

  function unselectAllSwGroups() {
    setCheckedSwScopeKeys(new Set())
  }

  function toggleSwGroupChecked(scopeKey: string) {
    setCheckedSwScopeKeys((prev) => {
      const next = new Set(prev)
      if (next.has(scopeKey)) next.delete(scopeKey)
      else next.add(scopeKey)
      return next
    })
  }

  function expandAllSwGroups() {
    setCollapsedSwGroups(new Set())
  }

  function collapseAllSwGroups() {
    setCollapsedSwGroups(new Set(swGroups.map((g) => g.scopeKey)))
  }

  function toggleSwGroupCollapsed(scopeKey: string) {
    setCollapsedSwGroups((prev) => {
      const next = new Set(prev)
      if (next.has(scopeKey)) next.delete(scopeKey)
      else next.add(scopeKey)
      return next
    })
  }

  function selectTest(testId: string) {
    setSelectedSwScopeKey(null)
    setSelectedTestId(testId)
  }

  function selectSwGroup(scopeKey: string) {
    setSelectedTestId(null)
    setSelectedSwScopeKey(scopeKey)
  }

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

  // T2.4: a requirement-scoped run over test cases that have no generated
  // automation just records zero outcomes (nothing to execute). Offer to
  // generate the missing files first — sequentially, same rationale as the
  // Test Creation screen's bulk button (the server's per-project run lock
  // rejects concurrent CLI runs anyway). Returns true if the caller should
  // proceed with the run, false if the user cancelled.
  async function ensureAutomationsForScope(scopeTests: TestCase[]): Promise<boolean> {
    const missing = scopeTests.filter((t) => !t.filePath)
    if (missing.length === 0) return true
    const proceed = window.confirm(
      `${missing.length} of these test case(s) have no generated automation yet, so running now would produce no result for them. Generate the missing test files first? (This makes ${missing.length} agent call(s) and may take a few minutes.)`,
    )
    if (!proceed) return true // run anyway — the diagnostic rawLog explains the empty result
    for (let i = 0; i < missing.length; i++) {
      setRunStatusText(`Generating test file ${i + 1}/${missing.length} (${missing[i].id})...`)
      onOperationChange({ text: `Generating test file ${i + 1}/${missing.length} (${missing[i].id})...` })
      await api.generateTestFile(projectId, missing[i].id)
    }
    await reload()
    return true
  }

  async function handleRunTests(test: TestCase) {
    await withBusyAction(`Running tests for ${scopeLabel(test, architecture!)}...`, async () => {
      await ensureAutomationsForScope([test])
      await api.runElementTests(projectId, scopeForTest(test), 'requirement')
      await reload()
    })
  }

  async function handleRunGroup(group: TestGroup) {
    await withBusyAction(`Running ${group.tests.length} test(s) for ${group.label}...`, async () => {
      await ensureAutomationsForScope(group.tests)
      await api.runElementTests(projectId, group.scope, 'requirement')
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
        await api.runElementTests(projectId, touchedGroups[i].scope, 'requirement')
      }
      await reload()
    })
  }

  async function handleRunAllTests() {
    if (!architecture || groups.length === 0) return
    const runnableGroups = readyGroups.filter((g) => g.tests.length > 0)
    await withBusyAction(`Running all requirement-based tests across ${runnableGroups.length} element(s)...`, async () => {
      await ensureAutomationsForScope(runnableGroups.flatMap((g) => g.tests))
      for (let i = 0; i < runnableGroups.length; i++) {
        setRunStatusText(`Running ${runnableGroups[i].label} (${i + 1}/${runnableGroups.length})...`)
        onOperationChange({ text: `Running ${runnableGroups[i].label} (${i + 1}/${runnableGroups.length})...` })
        await api.runElementTests(projectId, runnableGroups[i].scope, 'requirement')
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

  async function handleRunSwGroup(group: SwTestGroup) {
    await withBusyAction(`Running coding-agent tests for ${group.label}...`, async () => {
      await api.runElementTests(projectId, group.scope, 'sw')
      await reload()
    })
  }

  async function handleRunAllSwGroups() {
    if (!architecture || swGroups.length === 0) return
    await withBusyAction(`Running coding-agent tests across ${swGroups.length} element(s)...`, async () => {
      for (let i = 0; i < swGroups.length; i++) {
        setRunStatusText(`Running ${swGroups[i].label} (${i + 1}/${swGroups.length})...`)
        onOperationChange({ text: `Running ${swGroups[i].label} (${i + 1}/${swGroups.length})...` })
        await api.runElementTests(projectId, swGroups[i].scope, 'sw')
      }
      await reload()
    })
  }

  async function handleRunSelectedSwGroups() {
    const selectedGroups = swGroups.filter((g) => checkedSwScopeKeys.has(g.scopeKey))
    if (selectedGroups.length === 0) return
    await withBusyAction(`Running coding-agent tests for ${selectedGroups.length} selected element(s)...`, async () => {
      for (let i = 0; i < selectedGroups.length; i++) {
        setRunStatusText(`Running ${selectedGroups[i].label} (${i + 1}/${selectedGroups.length})...`)
        onOperationChange({ text: `Running ${selectedGroups[i].label} (${i + 1}/${selectedGroups.length})...` })
        await api.runElementTests(projectId, selectedGroups[i].scope, 'sw')
      }
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

  const sendQaExecutionChat = useCallback(
    async (sessionId: string, message: string) => {
      onOperationChange({ text: 'QA is thinking...' })
      try {
        const result = await api.testExecutionChat(
          projectId,
          selectedTest?.id ?? null,
          latest?.run.id ?? null,
          message,
          sessionId,
        )
        if (result.dispatch) {
          // The dispatch mutated project state (element.pendingRecodeReason
          // / a requirement's text) — reload so the rest of this screen (and
          // any element/requirement status it derives) reflects it. The
          // dispatch summary + link chips render from the persisted
          // assistant message itself (see ChatTranscript).
          await reload()
        }
        onOperationChange({ text: null })
        return { userMessage: result.userMessage, assistantMessage: result.assistantMessage }
      } catch (err) {
        onOperationChange(toOperationError(err))
        throw err
      }
    },
    // The callback re-creates when the focused test or run changes, which
    // is what we want (a new send should target the current focus). reload
    // is a plain per-render function — same disable the rest of this file
    // uses for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, projectId, selectedTest?.id, latest?.run.id, onOperationChange],
  )

  // Consume a chat link chip that targeted a test case — select it here.
  useEffect(() => {
    if (!pendingChatNav || pendingChatNav.kind !== 'testCase') return
    setSelectedTestId(pendingChatNav.id)
    onChatNavConsumed()
  }, [pendingChatNav, onChatNavConsumed])

  function renderTestGroup(group: TestGroup, ready: boolean) {
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
    const allChecked = group.tests.length > 0 && group.tests.every((t) => checkedTestIds.has(t.id))
    const someChecked = !allChecked && group.tests.some((t) => checkedTestIds.has(t.id))
    const passedCount = groupOutcomes.filter((o) => o && o.passed).length
    const ranCount = groupOutcomes.filter(Boolean).length
    const collapsed = collapsedGroups.has(group.scopeKey)
    const readiness = readinessByScopeKey.get(group.scopeKey)
    const notReadyReason = notReadyReasonLabel(readiness)
    const failingOutcomes = groupOutcomes.filter((o): o is NonNullable<typeof o> => !!o && !o.passed)
    const untriaged = failingOutcomes.filter((o) => !o.triage || o.triage === 'unattributed').length
    const needsConfirm = failingOutcomes.filter((o) => o.triage === 'test-case-failure' && !o.testCaseFailureConfirmedAt).length
    const codeFailures = failingOutcomes.filter((o) => o.triage === 'code-failure').length
    const confirmedTestCaseFailures = failingOutcomes.filter((o) => o.triage === 'test-case-failure' && o.testCaseFailureConfirmedAt).length
    const failureBreakdown = [
      untriaged > 0 ? `${untriaged} not yet triaged` : null,
      needsConfirm > 0 ? `${needsConfirm} awaiting confirmation` : null,
      codeFailures > 0 ? `${codeFailures} code failure(s)` : null,
      confirmedTestCaseFailures > 0 ? `${confirmedTestCaseFailures} confirmed test-case failure(s)` : null,
    ]
      .filter(Boolean)
      .join(', ')
    const groupTooltip =
      notReadyReason ??
      (ranCount === 0
        ? `${group.tests.length} test(s) ready to run — click Run Group, or select individual tests to run.`
        : anyFailed
          ? `${passedCount}/${ranCount} passed — click a test below to open it (${failureBreakdown}).`
          : `${passedCount}/${ranCount} passed — all tests for ${group.label} are green.`)

    if (group.tests.length === 0) return null

    return (
      <div
        key={group.scopeKey}
        className={ready ? 'test-execution-group' : 'test-execution-group test-execution-group-not-ready'}
      >
        <div
          className="test-execution-group-header has-tooltip"
          data-tooltip={groupTooltip}
          onClick={() => toggleGroupCollapsed(group.scopeKey)}
          role="button"
          tabIndex={0}
          aria-label={collapsed ? `Expand ${group.label}` : `Collapse ${group.label}`}
          aria-expanded={!collapsed}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              toggleGroupCollapsed(group.scopeKey)
            }
          }}
        >
          <span className="test-execution-group-toggle" aria-hidden="true">
            {collapsed ? '▸' : '▾'}
          </span>
          <input
            type="checkbox"
            checked={allChecked}
            disabled={group.tests.length === 0 || !ready}
            ref={(el) => {
              if (el) el.indeterminate = someChecked
            }}
            onChange={() => toggleGroup(group)}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Select all tests for ${group.label}`}
            title={notReadyReason ?? `Select all tests for ${group.label}`}
          />
          <span className="test-execution-status-dot" style={{ background: groupDotColor }} />
          <span className="test-execution-group-title">{group.label}</span>
          <span className="test-execution-group-summary">
            {ranCount === 0 ? `${group.tests.length} not run` : `${passedCount}/${ranCount} passed, ${group.tests.length} total`}
          </span>
          <button
            type="button"
            className="test-execution-group-run has-tooltip"
            onClick={(e) => {
              e.stopPropagation()
              handleRunGroup(group)
            }}
            disabled={busy || !ready}
            data-tooltip={notReadyReason ?? `Run all ${group.tests.length} test(s) for ${group.label}.`}
          >
            Run Group
          </button>
        </div>
        {!collapsed && (
          <ul className="test-execution-group-list">
            {group.tests.map((test) => {
              const found = latestRunForTest(runs, test.id)
              const outcome = found?.outcome
              const fileMissing = !outcome && fileMissingForTest(runs, test.id)
              // T1.5(b): the test's scope was run but this test produced no
              // outcome — it has no generated file (or one the runner can't
              // match). Distinct from "never attempted".
              const ranButNoOutcome =
                !outcome && !fileMissing && !test.filePath && !!attemptedWithoutOutcome(runs, test)
              const dotColor =
                fileMissing || ranButNoOutcome
                  ? STATUS_COLOR.blocked
                  : !outcome
                    ? STATUS_COLOR['not-started']
                    : outcome.passed
                      ? STATUS_COLOR.complete
                      : STATUS_COLOR.blocked
              return (
                <li
                  key={test.id}
                  className={
                    test.id === selectedTestId
                      ? 'test-execution-row test-execution-row-selected has-tooltip'
                      : 'test-execution-row has-tooltip'
                  }
                  data-tooltip={
                    notReadyReason ??
                    (fileMissing
                      ? 'This test was generated once, but its file is missing from disk (source tree re-coded). Regenerate it via Generate Test File on the Test Creation tab.'
                      : ranButNoOutcome
                        ? 'This test’s scope was run but it has no generated automation, so nothing executed for it. Generate its test file on the Test Creation tab.'
                        : testRowTooltip(outcome))
                  }
                >
                  <input
                    type="checkbox"
                    checked={checkedTestIds.has(test.id)}
                    disabled={!ready}
                    onChange={() => toggleTest(test.id)}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={`Select ${test.title}`}
                  />
                  <span className="test-execution-row-body" onClick={() => selectTest(test.id)}>
                    <span className="test-execution-status-dot" style={{ background: dotColor }} />
                    <span className="test-execution-title">{test.title}</span>
                    <span className="test-execution-run-state">
                      {fileMissing
                        ? 'File missing — regenerate'
                        : ranButNoOutcome
                          ? 'Not executed — no file'
                          : !outcome
                            ? 'Not run'
                            : outcome.passed
                              ? 'Passed'
                              : 'Failed'}
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
  }

  if (!architecture || architecture.elements.length === 0) {
    return (
      <div className="test-execution-screen">
        <p className="test-execution-hint">
          No architecture elements yet — add elements on the Architecture tab, then create tests on the Test
          Creation tab, before running tests here.
        </p>
      </div>
    )
  }

  return (
    <div className="test-execution-screen">
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
        {notReadyTestCount > 0 && (
          <span className="test-execution-regression-awaiting">
            {notReadyTestCount} test{notReadyTestCount === 1 ? '' : 's'} not ready to run — element{notReadyGroups.length === 1 ? '' : 's'}{' '}
            not yet coded
          </span>
        )}
        {awaitingRegressionCount > 0 && (
          <span className="test-execution-regression-awaiting">
            {awaitingRegressionCount} requirement{awaitingRegressionCount === 1 ? '' : 's'} tested and awaiting regression to reach Complete
          </span>
        )}
      </div>

      <div className="test-execution-panels-row">
        <div className="test-execution-frame test-execution-frame-left">
          <div className="test-execution-column-header">
            <h2>Requirement based Test cases</h2>
            <span className="test-execution-column-subtitle">Requirement-traced tests created in Step 4</span>
          </div>
          <div className="test-execution-panel-actions">
            <button type="button" onClick={handleRunAllTests} disabled={busy || tests.length === 0}>
              Run All
            </button>
            <button type="button" onClick={handleRunSelected} disabled={busy || checkedCount === 0}>
              Run Selected{checkedCount > 0 ? ` (${checkedCount})` : ''}
            </button>
            <button type="button" className="test-execution-secondary-button" onClick={selectAllTests} disabled={tests.length === 0}>
              Select All
            </button>
            <button type="button" className="test-execution-secondary-button" onClick={unselectAllTests} disabled={checkedCount === 0}>
              Unselect All
            </button>
            <button type="button" className="test-execution-secondary-button" onClick={expandAllGroups} disabled={groups.length === 0}>
              Expand
            </button>
            <button type="button" className="test-execution-secondary-button" onClick={collapseAllGroups} disabled={groups.length === 0}>
              Collapse
            </button>
          </div>
          <div className="test-execution-list">
            {readyGroups.map((group) => renderTestGroup(group, true))}
            {notReadyGroups.some((g) => g.tests.length > 0) && (
              <div className="test-execution-subsection-heading">
                Not ready to run ({notReadyTestCount})
              </div>
            )}
            {notReadyGroups.map((group) => renderTestGroup(group, false))}
            {groups.every((g) => g.tests.length === 0) && (
              <p className="test-execution-hint">No requirement-based test cases yet — create them on the Test Creation tab.</p>
            )}
          </div>
        </div>

        <div className="test-execution-frame test-execution-frame-right">
          <div className="test-execution-column-header">
            <h2>SW tests (Coding)</h2>
            <span className="test-execution-column-subtitle">Test files the coding agent wrote in Step 5</span>
          </div>
          <div className="test-execution-panel-actions">
            <button type="button" onClick={handleRunAllSwGroups} disabled={busy || swGroups.length === 0}>
              Run All
            </button>
            <button type="button" onClick={handleRunSelectedSwGroups} disabled={busy || checkedSwCount === 0}>
              Run Selected{checkedSwCount > 0 ? ` (${checkedSwCount})` : ''}
            </button>
            <button
              type="button"
              className="test-execution-secondary-button"
              onClick={selectAllSwGroups}
              disabled={swGroups.length === 0}
            >
              Select All
            </button>
            <button
              type="button"
              className="test-execution-secondary-button"
              onClick={unselectAllSwGroups}
              disabled={checkedSwCount === 0}
            >
              Unselect All
            </button>
            <button
              type="button"
              className="test-execution-secondary-button"
              onClick={expandAllSwGroups}
              disabled={swGroups.length === 0}
            >
              Expand
            </button>
            <button
              type="button"
              className="test-execution-secondary-button"
              onClick={collapseAllSwGroups}
              disabled={swGroups.length === 0}
            >
              Collapse
            </button>
          </div>
          <div className="test-execution-list">
            {swGroups.map((group) => {
              const swPassedCount = group.outcomes.filter((o) => o.passed).length
              const swDotColor = !group.run
                ? STATUS_COLOR['not-started']
                : group.outcomes.length === 0
                  ? STATUS_COLOR['not-started']
                  : swPassedCount === group.outcomes.length
                    ? STATUS_COLOR.complete
                    : STATUS_COLOR.blocked
              const collapsed = collapsedSwGroups.has(group.scopeKey)
              const swReadiness = readinessByScopeKey.get(group.scopeKey)
              const swNotReadyReason = notReadyReasonLabel(swReadiness)
              const swGroupTooltip =
                swNotReadyReason ??
                (!group.run
                  ? `Not run yet — click Run to discover and execute test files the coding agent wrote for ${group.label}.`
                  : group.outcomes.length === 0
                    ? 'No test files were found for this scope on the last run.'
                    : `${swPassedCount}/${group.outcomes.length} passed — click ${group.label} to view raw output.`)

              return (
                <div key={group.scopeKey} className="test-execution-group">
                  <div
                    className="test-execution-group-header has-tooltip"
                    data-tooltip={swGroupTooltip}
                    onClick={() => toggleSwGroupCollapsed(group.scopeKey)}
                    role="button"
                    tabIndex={0}
                    aria-label={collapsed ? `Expand ${group.label}` : `Collapse ${group.label}`}
                    aria-expanded={!collapsed}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        toggleSwGroupCollapsed(group.scopeKey)
                      }
                    }}
                  >
                    <span className="test-execution-group-toggle" aria-hidden="true">
                      {collapsed ? '▸' : '▾'}
                    </span>
                    <input
                      type="checkbox"
                      checked={checkedSwScopeKeys.has(group.scopeKey)}
                      onChange={() => toggleSwGroupChecked(group.scopeKey)}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`Select ${group.label}`}
                      title={`Select ${group.label}`}
                    />
                    <span className="test-execution-status-dot" style={{ background: swDotColor }} />
                    <span
                      className="test-execution-group-title test-execution-group-title-clickable"
                      onClick={(e) => {
                        e.stopPropagation()
                        selectSwGroup(group.scopeKey)
                      }}
                    >
                      {group.label}
                    </span>
                    <span className="test-execution-group-summary">
                      {!group.run ? 'not run' : group.outcomes.length === 0 ? 'none found' : `${swPassedCount}/${group.outcomes.length} passed`}
                    </span>
                    <button
                      type="button"
                      className="test-execution-group-run has-tooltip"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleRunSwGroup(group)
                      }}
                      disabled={busy}
                      data-tooltip={`Run coding-agent tests for ${group.label}.`}
                    >
                      Run
                    </button>
                  </div>
                  {!collapsed && (
                    <>
                      {group.outcomes.length > 0 && (
                        <ul className="test-execution-group-list">
                          {group.outcomes.map((o) => (
                            <li key={o.name} className="test-execution-row has-tooltip" data-tooltip={swOutcomeTooltip(o)}>
                              <span className="test-execution-row-body">
                                <span
                                  className="test-execution-status-dot"
                                  style={{ background: o.passed ? STATUS_COLOR.complete : STATUS_COLOR.blocked }}
                                />
                                <span className="test-execution-title">{o.name}</span>
                                <span className="test-execution-run-state">{o.passed ? 'Passed' : 'Failed'}</span>
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                      {group.run && group.outcomes.length === 0 && (
                        <div className="test-execution-sw-subsection-note">
                          {group.run.exitCode === null
                            ? group.run.rawLog
                            : 'No test files were written by the Step 5 coding agent for this scope.'}
                        </div>
                      )}
                      {!group.run && <p className="test-execution-hint">Not run yet.</p>}
                    </>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        <div
          className={readyGroups.length === 0 ? 'test-execution-regression-frame has-tooltip' : 'test-execution-regression-frame'}
          data-tooltip={readyGroups.length === 0 ? 'No element is coded yet — nothing to regress.' : undefined}
        >
          <button type="button" className="test-execution-regression-button" onClick={handleRunRegression} disabled={busy}>
            Run Regression
          </button>
          <span className="test-execution-regression-frame-summary">
            {readyGroups.length}/{groups.length} element{groups.length === 1 ? '' : 's'} ready
          </span>
        </div>
      </div>

      <div className="test-execution-bottom">
        <div className="test-execution-detail-pane">
          {selectedTest ? (
            <>
              <div className="test-execution-detail-header">
                <h2>{selectedTest.title}</h2>
                <button type="button" onClick={() => handleRunTests(selectedTest)} disabled={busy}>
                  Run Tests
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
          ) : selectedSwGroup ? (
            <>
              <div className="test-execution-detail-header">
                <h2>{selectedSwGroup.label} — SW tests</h2>
                <button type="button" onClick={() => handleRunSwGroup(selectedSwGroup)} disabled={busy}>
                  Run Tests
                </button>
              </div>
              {!selectedSwGroup.run ? (
                <p className="test-execution-hint">No test run yet for this scope.</p>
              ) : (
                <>
                  <p className="test-execution-hint">Last run: {selectedSwGroup.run.startedAt}</p>
                  <details className="test-execution-raw-log" open>
                    <summary>Raw output</summary>
                    <pre>{selectedSwGroup.run.rawLog}</pre>
                  </details>
                </>
              )}
            </>
          ) : (
            <p className="test-execution-hint">Select a test to view its detail.</p>
          )}
        </div>

      </div>

      <button
        type="button"
        className={historyOpen ? 'test-execution-history-tab test-execution-history-tab-open' : 'test-execution-history-tab'}
        onClick={() => setHistoryOpen((v) => !v)}
        aria-expanded={historyOpen}
      >
        <span className="test-execution-history-tab-icon">{historyOpen ? '▸' : '◂'}</span>
        <span className="test-execution-history-tab-label">Run History</span>
      </button>

      {historyOpen && (
        <>
          <div className="test-execution-history-scrim" onClick={() => setHistoryOpen(false)} />
          <div className="test-execution-history-pane">
            <div className="test-execution-history-pane-header">
              <h2>Run History</h2>
              <button
                type="button"
                className="test-execution-history-close"
                onClick={() => setHistoryOpen(false)}
                aria-label="Close run history"
              >
                ✕
              </button>
            </div>
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
        </>
      )}

      <ChatDock
        api={api}
        projectId={projectId}
        surface="qa-execution"
        roleLabel="QA"
        heading="QA chat"
        hint="Ask QA to help interpret a run's output, or describe an issue you found — QA may dispatch it as a requirement change, a test case fix, or a coding fix."
        placeholder="Ask QA..."
        currentFocus={{ testCaseId: selectedTest?.id, runId: latest?.run.id }}
        onOpenSettings={onOpenSettings}
        onNavigateLink={onChatNavigate}
        renderMessageText={highlightRequirementIds}
        sendMessage={sendQaExecutionChat}
      />
    </div>
  )
}
