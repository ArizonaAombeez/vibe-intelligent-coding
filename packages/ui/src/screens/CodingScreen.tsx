import { useEffect, useRef, useState } from 'react'
import type {
  Architecture,
  ArchitectureElement,
  CodingRun,
  CurrentOperation,
  ElementRequirementCoverage,
  Requirement,
  Status,
  TestRegressionRun,
  VicCoreApi,
} from '../api/types'
import { toOperationError } from '../api/errorCode'
import { REQUIREMENT_STATUS_LABEL, STATUS_COLOR, STATUS_LABEL } from '../statusColor'
import { formatCodingLog } from './formatCodingLog'
import { HighlightedCode, HighlightedLine, langForFilePath } from './highlightCode'
import type { CodeLang } from './highlightCode'
import './RequirementsScreen.css'
import './CodingScreen.css'

// This screen was fully rewritten for the element-based Coding migration
// (hide-not-delete): it now operates directly on architecture elements and
// their live-allocated requirements instead of Story/Backlog — Coding is
// fully disconnected from Planning. Planning's own screen/backend stay
// completely intact elsewhere; this file simply no longer talks to them.
interface CodingScreenProps {
  api: VicCoreApi
  projectId: string
  onOperationChange: (op: CurrentOperation) => void
  onOpenSettings: () => void
}

function triggerBrowserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

function isHtmlFile(filePath: string): boolean {
  return /\.html?$/i.test(filePath)
}

const COVERAGE_COLOR: Record<ElementRequirementCoverage['status'], string> = {
  satisfied: 'var(--status-green)',
  partial: 'var(--status-amber)',
  'not-satisfied': 'var(--status-red)',
}

const COVERAGE_LABEL: Record<ElementRequirementCoverage['status'], string> = {
  satisfied: 'Satisfied',
  partial: 'Partial',
  'not-satisfied': 'Not satisfied',
}

function CodeCheckPanel({ coverage }: { coverage: ElementRequirementCoverage[] }) {
  return (
    <div className="coding-code-check-panel">
      <h3 className="coding-code-check-heading">Code vs. requirements</h3>
      {coverage.map((c) => (
        <div key={c.requirementId} className="coding-code-check-row">
          <div className="coding-code-check-row-heading">
            <span className="coding-status-dot" style={{ background: COVERAGE_COLOR[c.status] }} />
            <span className="coding-code-check-req-id">{c.requirementId}</span>
            <span className="coding-status-badge" style={{ background: COVERAGE_COLOR[c.status] }}>
              {COVERAGE_LABEL[c.status]}
            </span>
          </div>
          <p className="coding-hint">{c.rationale}</p>
        </div>
      ))}
    </div>
  )
}

// Diff header lines (diff --git, index, ---/+++, @@) carry their own path,
// so the changed file's extension picks the language used to color the code
// *inside* +/- lines — tracked as we walk the lines top to bottom.
// Colors formatCodingLog's summary lines by their leading marker: tool
// calls ('• '), tool errors ('✗ '), and reasoning/thinking text ('💭 ') —
// everything else (plain model text, raw fallback lines) is left uncolored
// since it isn't a distinct category.
function LogLine({ line }: { line: string }) {
  if (line.startsWith('✗ ')) return <div className="coding-log-line coding-log-line-error">{line}</div>
  if (line.startsWith('\u{1F4AD} ')) return <div className="coding-log-line coding-log-line-thinking">{line}</div>
  if (line.startsWith('• ')) return <div className="coding-log-line coding-log-line-tool">{line}</div>
  return <div className="coding-log-line">{line}</div>
}

function FormattedLog({ text }: { text: string }) {
  const lines = formatCodingLog(text).split('\n')
  return (
    <>
      {lines.map((line, i) => (
        <LogLine key={i} line={line} />
      ))}
    </>
  )
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const remainderSeconds = Math.round(seconds % 60)
  return `${minutes}m ${remainderSeconds}s`
}

// Above this, msToFirstOutput is flagged as a warning rather than shown as
// a plain stat — distinguishes "the provider took unusually long to start
// responding at all" (worth a human's attention, since it's the exact
// signal that diagnosed a real ~320s stall-before-first-tool-call on one
// GLM run, with everything after that point running at completely normal
// speed) from ordinary startup variance. Not a hard failure threshold —
// just a visibility cue in the UI.
const SLOW_START_WARNING_MS = 60_000

// Provider-agnostic run-timing summary — works identically for any agent
// client (ClaudeCodeAgentClient, OpenCodeAgentClient, or a future one),
// since AgentRunTiming is derived purely from process lifecycle events
// (spawn/first output/exit), never a provider-specific event schema. Shows
// which provider/model actually ran (recorded on CodingRun so this can be
// compared across runs made with different plugins later, not just
// inferred in the moment), total CLI duration, and — the key diagnostic —
// how long the provider took before producing anything at all.
function RunTimingSummary({ run }: { run: CodingRun }) {
  if (!run.timing && !run.providerId && !run.model) return null
  const slowStart = (run.timing?.msToFirstOutput ?? 0) > SLOW_START_WARNING_MS
  return (
    <div className={`coding-run-timing${slowStart ? ' coding-run-timing-warning' : ''}`}>
      {run.providerId && <span className="coding-run-timing-item">provider: {run.providerId}</span>}
      {run.model && <span className="coding-run-timing-item">model: {run.model}</span>}
      {run.timing?.msToFirstOutput !== undefined && (
        <span className="coding-run-timing-item">
          time to first response: {formatMs(run.timing.msToFirstOutput)}
          {slowStart && ' — unusually slow to start'}
        </span>
      )}
      {run.timing && <span className="coding-run-timing-item">total CLI time: {formatMs(run.timing.msTotal)}</span>}
    </div>
  )
}

function DiffView({ diff }: { diff: string }) {
  if (!diff.trim()) {
    return <p className="coding-hint">No diff for this run.</p>
  }
  const lines = diff.split('\n')
  let lang: CodeLang = 'plain'
  return (
    <pre className="coding-diff">
      {lines.map((line, i) => {
        if (line.startsWith('diff --git')) {
          const match = line.match(/ b\/(\S+)$/)
          lang = match ? langForFilePath(match[1]) : 'plain'
        }
        const isAdd = line.startsWith('+') && !line.startsWith('+++')
        const isRemove = line.startsWith('-') && !line.startsWith('---')
        const cls = isAdd ? 'coding-diff-add' : isRemove ? 'coding-diff-remove' : 'coding-diff-context'
        const isHeader = /^(diff --git|index |---|\+\+\+|@@)/.test(line)
        return (
          <div key={i} className={cls}>
            {isHeader || lang === 'plain' ? line : <HighlightedLine line={line} lang={lang} />}
          </div>
        )
      })}
    </pre>
  )
}

// An element's rollup status, derived the same way ArchitectureScreen.tsx's
// deriveElementStatus already does — not-started (nothing allocated),
// blocked (any allocated requirement is tested-fail), complete (every
// allocated requirement is 'complete'), else in-progress. No conflict input
// here (Coding doesn't track architecture conflicts), unlike Architecture's
// own richer version.
function deriveElementStatus(elementId: string, requirements: Requirement[]): Status {
  const allocated = requirements.filter((r) => r.architectureElements.includes(elementId))
  if (allocated.length === 0) return 'not-started'
  if (allocated.some((r) => r.status === 'tested-fail')) return 'blocked'
  if (allocated.every((r) => r.status === 'complete')) return 'complete'
  return 'in-progress'
}

export function CodingScreen({ api, projectId, onOperationChange }: CodingScreenProps) {
  const [architecture, setArchitecture] = useState<Architecture | null>(null)
  const [requirements, setRequirements] = useState<Requirement[]>([])
  const [runs, setRuns] = useState<CodingRun[]>([])
  const [sourceRoot, setSourceRoot] = useState<string | null>(null)
  const [sourceFiles, setSourceFiles] = useState<Array<{ path: string; size: number }>>([])
  const [previewFilePath, setPreviewFilePath] = useState<string | null>(null)
  const [previewText, setPreviewText] = useState<string | null>(null)
  const [previewTextError, setPreviewTextError] = useState<string | null>(null)
  const [downloadBusy, setDownloadBusy] = useState(false)
  const [selectedElementId, setSelectedElementId] = useState<string | null>(null)
  const [conventions, setConventions] = useState('')
  const [busy, setBusy] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Live output for whichever element is currently being coded (set by
  // handleRunCoding/handleCodeAll, cleared once that run's poll loop sees
  // done:true or the outer request settles) — liveLogElementId lets the
  // detail pane show the live panel only when it's actually looking at the
  // element that's running, not a different one the user has since
  // selected.
  const [liveLogElementId, setLiveLogElementId] = useState<string | null>(null)
  const [liveLog, setLiveLog] = useState('')
  // How long (ms) since the CLI subprocess behind the live run last produced
  // any output, per the server's runLogRegistry.ts — lets the panel show
  // "still working" vs. flag a stall, instead of a silent, indistinguishable
  // "Waiting for output..." forever (see STALE_ACTIVITY_MS below).
  const [liveLogMsSinceActivity, setLiveLogMsSinceActivity] = useState(0)
  const liveLogRef = useRef<HTMLPreElement>(null)

  // Whether *any* run — including one started by a different user/tab — is
  // currently holding this project's Coding-run lock (see
  // acquireProjectRunLock in runLogRegistry.ts). Polled independently of
  // liveLogElementId, which only reflects a run *this* browser tab started.
  const [projectLock, setProjectLock] = useState<{ architectureElementId?: string; userId?: string; startedAt?: number } | null>(null)
  const [cancelBusy, setCancelBusy] = useState(false)

  // "Analyse Code" results, keyed by architectureElementId — kept
  // client-side only (not re-fetched from project.elementCodeChecks on
  // load) since it's meant to reflect "what did the last analysis *this
  // session* find," matching how the diff/log panel above already only
  // ever shows the current session's view of the latest run.
  const [codeChecks, setCodeChecks] = useState<Record<string, ElementRequirementCoverage[]>>({})
  const [analyzeBusy, setAnalyzeBusy] = useState(false)
  const [analyzeError, setAnalyzeError] = useState<string | null>(null)

  // "Test Full App" — runs every element's + every connected interface
  // pair's own test suite together (runFullRegression, already used
  // elsewhere for the same aggregation) so there's at least one check that
  // the whole assembled app still works, not just each element in
  // isolation. Client-side only, same "reflects this session's latest run"
  // convention as codeChecks above.
  const [testFullAppBusy, setTestFullAppBusy] = useState(false)
  const [fullAppTestResult, setFullAppTestResult] = useState<TestRegressionRun | null>(null)

  useEffect(() => {
    if (!liveLogRef.current) return
    liveLogRef.current.scrollTop = liveLogRef.current.scrollHeight
  }, [liveLog])

  // Fetches the raw text of a selected non-HTML file for the highlighted
  // code preview below — HTML files instead render live in the iframe, so
  // this only runs for everything else. sourceFileUrl already serves plain
  // file bytes, so a direct fetch is enough; no dedicated JSON endpoint.
  useEffect(() => {
    if (!previewFilePath || isHtmlFile(previewFilePath)) {
      setPreviewText(null)
      setPreviewTextError(null)
      return
    }
    let cancelled = false
    setPreviewText(null)
    setPreviewTextError(null)
    fetch(api.sourceFileUrl(projectId, previewFilePath))
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load file (${res.status})`)
        return res.text()
      })
      .then((text) => {
        if (!cancelled) setPreviewText(text)
      })
      .catch((err) => {
        if (!cancelled) setPreviewTextError(err instanceof Error ? err.message : 'Failed to load file.')
      })
    return () => {
      cancelled = true
    }
  }, [api, projectId, previewFilePath])

  // Polls this project's run-lock status regardless of whether this tab is
  // the one running Coding — so a second user opening the same project sees
  // "already running, started by X" before they ever click Code themselves,
  // not just as a 409 after trying. Stops polling once this tab starts its
  // own run (liveLogElementId set) since pollRunLog below takes over that
  // element's feedback; resumes once the tab is idle again.
  useEffect(() => {
    if (liveLogElementId) return
    let cancelled = false
    const poll = async () => {
      if (cancelled) return
      try {
        const result = await api.getCodingRunLock(projectId)
        if (cancelled) return
        setProjectLock(
          result.locked
            ? { architectureElementId: result.architectureElementId, userId: result.userId, startedAt: result.startedAt }
            : null,
        )
      } catch {
        // Transient fetch failure — leave the last known state as-is;
        // next tick will retry.
      }
    }
    poll()
    const timer = setInterval(poll, 4000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [api, projectId, liveLogElementId])

  // Past this many ms with no new output, the live panel flags the run as
  // possibly stalled rather than just showing the last line forever — a
  // CLI subprocess that stops producing output without exiting (the class
  // of bug that motivated msSinceLastActivity existing at all) otherwise
  // looks identical to one still working normally.
  const STALE_ACTIVITY_MS = 60_000

  // Polls GET /api/coding/runs/:token/log on an interval (same idiom as
  // App.tsx's plugin-usage poll) until the run reports done, the caller's
  // own outer request settles, or the component unmounts — whichever comes
  // first. Runs the poll independently of (in parallel with) the blocking
  // api.runCoding call, since that's the whole point: the token exists
  // specifically so this can start before that call resolves.
  function pollRunLog(architectureElementId: string, runToken: string): () => void {
    let cancelled = false
    setLiveLogElementId(architectureElementId)
    setLiveLog('')
    setLiveLogMsSinceActivity(0)
    const poll = async () => {
      if (cancelled) return
      try {
        const result = await api.getCodingRunLog(runToken)
        if (cancelled) return
        setLiveLog(result.text)
        setLiveLogMsSinceActivity(result.msSinceLastActivity)
        if (result.done) cancelled = true
      } catch {
        // Token not found yet (route not reached) or expired — keep
        // polling; the outer request's own finally clears liveLogElementId
        // regardless once it settles.
      }
    }
    poll()
    const timer = setInterval(poll, 1500)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }

  async function reload() {
    try {
      const [a, reqs, r, c, tree] = await Promise.all([
        api.getArchitecture(projectId),
        api.listRequirements(projectId),
        api.listCodingRuns(projectId),
        api.getCodingConventions(projectId),
        api.getSourceTree(projectId),
      ])
      setArchitecture(a)
      setRequirements(reqs)
      setRuns(r)
      setConventions(c)
      setSourceRoot(tree.root)
      setSourceFiles(tree.files)
      setLoadError(null)
    } catch (err) {
      setLoadError(toOperationError(err).error ?? 'Failed to load Coding data.')
    }
  }

  async function handleDownloadAll() {
    if (downloadBusy) return
    setDownloadBusy(true)
    try {
      const { blob, filename } = await api.downloadSourceTree(projectId)
      triggerBrowserDownload(blob, filename)
    } catch (err) {
      onOperationChange(toOperationError(err))
    } finally {
      setDownloadBusy(false)
    }
  }

  useEffect(() => {
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, projectId])

  const elements = architecture?.elements ?? []
  const selectedElement = elements.find((e) => e.id === selectedElementId) ?? null
  const selectedElementRequirements = selectedElementId
    ? requirements.filter((r) => !r.deletedAt && r.architectureElements.includes(selectedElementId))
    : []
  const latestRunForSelected = runs
    .filter((r) => r.architectureElementId === selectedElementId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]

  async function handleScaffold() {
    if (busy) return
    setBusy(true)
    onOperationChange({ text: 'Scaffolding source tree...' })
    try {
      await api.scaffoldSourceTree(projectId)
      onOperationChange({ text: null })
    } catch (err) {
      onOperationChange(toOperationError(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleRunCoding(element: ArchitectureElement, recode = false, fromScratch = false) {
    if (busy) return
    if (!fromScratch && recode && !window.confirm('Update this element\'s code? This will regenerate it and create a new commit.')) {
      return
    }
    setBusy(true)
    onOperationChange({
      text: `${fromScratch ? 'Coding' : recode ? 'Updating code for' : 'Coding'} ${element.id}...`,
    })
    const runToken = crypto.randomUUID()
    const stopPolling = pollRunLog(element.id, runToken)
    try {
      await api.runCoding(projectId, element.id, runToken, recode, fromScratch)
      await reload()
      onOperationChange({ text: null })
    } catch (err) {
      onOperationChange(toOperationError(err))
    } finally {
      stopPolling()
      setLiveLogElementId(null)
      setBusy(false)
    }
  }

  async function handleCancelRun() {
    if (cancelBusy) return
    if (!window.confirm('Cancel the in-progress Coding run for this project? Any partial changes made so far are left as-is.')) {
      return
    }
    setCancelBusy(true)
    try {
      await api.cancelCodingRun(projectId)
    } catch (err) {
      onOperationChange(toOperationError(err))
    } finally {
      setCancelBusy(false)
    }
  }

  async function handleAnalyzeCode(element: ArchitectureElement) {
    if (analyzeBusy) return
    setAnalyzeBusy(true)
    setAnalyzeError(null)
    onOperationChange({ text: `Analysing code for ${element.id}...` })
    try {
      const { coverage } = await api.analyzeElementCode(projectId, element.id)
      setCodeChecks((prev) => ({ ...prev, [element.id]: coverage }))
      onOperationChange({ text: null })
    } catch (err) {
      const op = toOperationError(err)
      setAnalyzeError(op.error ?? 'Failed to analyse code.')
      onOperationChange(op)
    } finally {
      setAnalyzeBusy(false)
    }
  }

  // Rebuilds every element in the list from scratch, one at a time (not in
  // parallel — each run is a real CLI invocation against the same shared
  // source tree, so concurrent runs would race on the same git repo/files).
  // Each element's own code folder is wiped before that element's run, same
  // as a single-element from-scratch rebuild — the agent writes fresh code
  // instead of reviewing/keeping whatever was there. Stops on the first
  // failure rather than plowing through the rest, same as a single Update
  // Code run surfaces its error via onOperationChange.
  async function handleCodeAll() {
    if (busy || elements.length === 0) return
    if (
      !window.confirm(
        'Code every element from scratch? This deletes everything currently in each element\'s code folder before writing fresh code — the agent won\'t see (or be able to keep) any existing implementation.',
      )
    ) {
      return
    }
    setBusy(true)
    try {
      for (const element of elements) {
        onOperationChange({ text: `Coding ${element.id}...` })
        const runToken = crypto.randomUUID()
        const stopPolling = pollRunLog(element.id, runToken)
        try {
          await api.runCoding(projectId, element.id, runToken, true, true)
        } finally {
          stopPolling()
        }
      }
      await reload()
      onOperationChange({ text: null })
    } catch (err) {
      onOperationChange(toOperationError(err))
    } finally {
      setLiveLogElementId(null)
      setBusy(false)
    }
  }

  async function handleTestFullApp() {
    if (busy || testFullAppBusy) return
    setTestFullAppBusy(true)
    onOperationChange({ text: 'Testing full app...' })
    try {
      const { regressionRun } = await api.runFullRegression(projectId)
      setFullAppTestResult(regressionRun)
      await reload()
      onOperationChange({ text: null })
    } catch (err) {
      onOperationChange(toOperationError(err))
    } finally {
      setTestFullAppBusy(false)
    }
  }

  async function handleSaveConventions() {
    if (busy) return
    setBusy(true)
    try {
      await api.setCodingConventions(projectId, conventions)
    } catch (err) {
      onOperationChange(toOperationError(err))
    } finally {
      setBusy(false)
    }
  }

  if (loadError) {
    return (
      <div className="coding-screen">
        <h1>Coding &amp; Review-Rework</h1>
        <div className="analyst-chat-error">
          <span>{loadError}</span>
          <button type="button" onClick={reload}>
            Retry
          </button>
        </div>
      </div>
    )
  }

  if (elements.length === 0) {
    return (
      <div className="coding-screen">
        <h1>Coding &amp; Review-Rework</h1>
        <p className="coding-hint">
          No architecture elements yet — add some on the Architecture tab, then allocate requirements to them before
          running Coding.
        </p>
      </div>
    )
  }

  return (
    <div className="coding-screen">
      <h1>Coding &amp; Review-Rework</h1>

      <div className="coding-settings-panel">
        <div className="coding-action-bar">
          <button type="button" onClick={handleScaffold} disabled={busy}>
            Scaffold source tree
          </button>
          <button type="button" onClick={handleCodeAll} disabled={busy || elements.length === 0 || !!projectLock}>
            Code All
          </button>
          <button
            type="button"
            onClick={handleTestFullApp}
            disabled={busy || testFullAppBusy || elements.length === 0 || !!projectLock}
            title="Runs every element's and every connected interface pair's own test suite together, so you can see whether the assembled app still works as a whole — not just each element on its own."
          >
            {testFullAppBusy ? 'Testing full app...' : 'Test Full App'}
          </button>
          {fullAppTestResult && (
            <span
              className="coding-full-app-result"
              style={{ color: fullAppTestResult.allPassed ? 'var(--status-passing, green)' : 'var(--status-failing, crimson)' }}
            >
              {fullAppTestResult.allPassed
                ? `All ${fullAppTestResult.runIds.length} test run(s) passed`
                : `Failures found across ${fullAppTestResult.runIds.length} test run(s)`}
            </span>
          )}
        </div>
        <label className="coding-conventions-label">
          Coding conventions
          <textarea
            value={conventions}
            onChange={(e) => setConventions(e.target.value)}
            onBlur={handleSaveConventions}
            placeholder="e.g. Use functional components, avoid default exports..."
            rows={3}
          />
        </label>
      </div>

      <div className="coding-files-panel">
        <div className="coding-files-header">
          <h2>Generated Files</h2>
          <div className="coding-files-header-actions">
            {sourceRoot && (
              <span className="coding-files-root" title={sourceRoot}>
                {sourceRoot}
              </span>
            )}
            <button type="button" onClick={handleDownloadAll} disabled={downloadBusy || sourceFiles.length === 0}>
              {downloadBusy ? 'Downloading...' : 'Download everything (.zip)'}
            </button>
          </div>
        </div>

        {sourceFiles.length === 0 ? (
          <p className="coding-hint">No files yet — scaffold the source tree and run Coding to generate files.</p>
        ) : (
          <div className="coding-files-body">
            <ul className="coding-files-list">
              {sourceFiles.map((file) => (
                <li key={file.path}>
                  <button
                    type="button"
                    className={
                      file.path === previewFilePath
                        ? 'coding-files-row coding-files-row-selected'
                        : 'coding-files-row'
                    }
                    onClick={() => setPreviewFilePath(file.path)}
                  >
                    <span className="coding-files-path">{file.path}</span>
                    {isHtmlFile(file.path) && <span className="coding-files-html-badge">HTML</span>}
                  </button>
                  <a
                    className="coding-files-open-link"
                    href={api.sourceFileUrl(projectId, file.path)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open in new tab
                  </a>
                </li>
              ))}
            </ul>

            {previewFilePath && (
              <div className="coding-files-preview">
                <div className="coding-files-preview-header">
                  <span>{previewFilePath}</span>
                  <div className="coding-files-preview-actions">
                    <a href={api.sourceFileUrl(projectId, previewFilePath)} target="_blank" rel="noreferrer">
                      Open in new tab
                    </a>
                    <button type="button" onClick={() => setPreviewFilePath(null)}>
                      Close
                    </button>
                  </div>
                </div>
                {isHtmlFile(previewFilePath) ? (
                  <iframe
                    className="coding-files-preview-frame"
                    src={api.sourceFileUrl(projectId, previewFilePath)}
                    title={previewFilePath}
                    sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
                  />
                ) : previewTextError ? (
                  <p className="coding-hint">{previewTextError}</p>
                ) : previewText === null ? (
                  <p className="coding-hint">Loading…</p>
                ) : (
                  <pre className="coding-code-preview">
                    <HighlightedCode code={previewText} lang={langForFilePath(previewFilePath)} />
                  </pre>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="coding-layout">
        <ul className="coding-story-list">
          {elements.map((element) => {
            const status = deriveElementStatus(element.id, requirements)
            const allocatedCount = requirements.filter(
              (r) => !r.deletedAt && r.architectureElements.includes(element.id),
            ).length
            return (
              <li
                key={element.id}
                className={
                  element.id === selectedElementId ? 'coding-story-row coding-story-row-selected' : 'coding-story-row'
                }
                onClick={() => setSelectedElementId(element.id)}
              >
                <span className="coding-status-dot" style={{ background: STATUS_COLOR[status] }} />
                <span className="coding-story-title">{element.name}</span>
                <span className="coding-status-badge" style={{ background: STATUS_COLOR[status] }}>
                  {STATUS_LABEL[status]}
                </span>
                {allocatedCount === 0 && <span className="coding-warning-badge">No requirements</span>}
              </li>
            )
          })}
        </ul>

        <div className="coding-detail-pane">
          {!selectedElement ? (
            <p className="coding-hint">Select an architecture element to view its Coding run.</p>
          ) : (
            <>
              <div className="coding-detail-header">
                <h2>{selectedElement.name}</h2>
                <button
                  type="button"
                  className="coding-recode-button"
                  onClick={() => handleRunCoding(selectedElement, true)}
                  disabled={busy || !!projectLock}
                  title="Codes this element for the first time, or updates its existing code to reflect a requirement/interface change or a manual re-code request."
                >
                  Update Code
                </button>
                <button
                  type="button"
                  className="coding-analyze-button"
                  onClick={() => handleAnalyzeCode(selectedElement)}
                  disabled={analyzeBusy || busy}
                >
                  Analyse Code
                </button>
              </div>
              <p className="coding-hint">{selectedElement.responsibility}</p>

              <div className="coding-element-requirements">
                <h3 className="coding-code-check-heading">Allocated requirements</h3>
                {selectedElementRequirements.length === 0 ? (
                  <p className="coding-hint">No requirements currently allocated to this element.</p>
                ) : (
                  <ul className="coding-element-requirement-list">
                    {selectedElementRequirements.map((r) => (
                      <li key={r.id}>
                        <span
                          className="coding-status-dot"
                          style={{
                            background:
                              STATUS_COLOR[
                                r.status === 'complete' ? 'complete' : r.status === 'tested-fail' ? 'blocked' : 'in-progress'
                              ],
                          }}
                          title={REQUIREMENT_STATUS_LABEL[r.status]}
                        />
                        <span className="coding-code-check-req-id">{r.id}</span>
                        <span>{r.text}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {!liveLogElementId && projectLock && (
                <div className="coding-run-banner coding-run-banner-locked">
                  Coding is already running for this project
                  {projectLock.userId ? ` (started by ${projectLock.userId})` : ''}
                  {projectLock.architectureElementId ? ` on element ${projectLock.architectureElementId}` : ''}
                  {projectLock.startedAt ? ` — running for ${Math.round((Date.now() - projectLock.startedAt) / 1000)}s` : ''}
                  . Try again once it finishes, or cancel it below if it looks stuck.
                  <button type="button" onClick={handleCancelRun} disabled={cancelBusy}>
                    {cancelBusy ? 'Cancelling…' : 'Cancel run'}
                  </button>
                </div>
              )}

              {liveLogElementId === selectedElement.id ? (
                <div className="coding-live-log">
                  <div className="coding-live-log-heading">
                    <span className="coding-live-log-dot" />
                    Coding in progress…
                    {liveLogMsSinceActivity >= STALE_ACTIVITY_MS ? (
                      <span className="coding-live-log-stale">
                        {' '}
                        No output for {Math.round(liveLogMsSinceActivity / 1000)}s — may be stuck
                      </span>
                    ) : (
                      liveLog && <span className="coding-live-log-fresh"> (updated {Math.round(liveLogMsSinceActivity / 1000)}s ago)</span>
                    )}
                    <button
                      type="button"
                      className="coding-live-log-cancel"
                      onClick={handleCancelRun}
                      disabled={cancelBusy}
                    >
                      {cancelBusy ? 'Cancelling…' : 'Cancel run'}
                    </button>
                  </div>
                  <pre ref={liveLogRef}>{liveLog ? <FormattedLog text={liveLog} /> : 'Waiting for output...'}</pre>
                </div>
              ) : latestRunForSelected ? (
                <>
                  {latestRunForSelected.status !== 'success' && (
                    <div className={`coding-run-banner coding-run-banner-${latestRunForSelected.status}`}>
                      {latestRunForSelected.status === 'rejected-not-eligible' &&
                        "None of this element's allocated requirements are pending — nothing for Coding to do."}
                      {latestRunForSelected.status === 'rejected-scope' && (
                        <>
                          The CLI wrote outside its allowed scope — those changes were reverted.
                          {latestRunForSelected.rejectedFiles && latestRunForSelected.rejectedFiles.length > 0 && (
                            <ul>
                              {latestRunForSelected.rejectedFiles.map((f) => (
                                <li key={f}>{f}</li>
                              ))}
                            </ul>
                          )}
                        </>
                      )}
                      {latestRunForSelected.status === 'rejected-empty-output' &&
                        "The coding agent finished without writing any code, so nothing was committed. If this followed a Recode from scratch, the previous implementation was restored rather than left deleted."}
                      {latestRunForSelected.status === 'cli-error' && 'The coding agent CLI run failed. See the raw log below.'}
                    </div>
                  )}
                  <RunTimingSummary run={latestRunForSelected} />
                  <DiffView diff={latestRunForSelected.diff} />
                  <details className="coding-raw-log">
                    <summary>Raw output</summary>
                    <pre><FormattedLog text={latestRunForSelected.rawLog} /></pre>
                  </details>
                </>
              ) : (
                <p className="coding-hint">No Coding run yet for this element.</p>
              )}

              {analyzeError && <p className="coding-error">{analyzeError}</p>}
              {codeChecks[selectedElement.id] && (
                <CodeCheckPanel coverage={codeChecks[selectedElement.id]} />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
