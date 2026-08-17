import { useEffect, useState } from 'react'
import type { CodeGapScanContentEstimate, CodeGapScanTokenEstimate, CodeStripOptions, ScanCodeGapsOptions, VicCoreApi } from '../api/types'
import { DEFAULT_CODE_STRIP_OPTIONS } from '../api/types'
import './ImportExportDialog.css'

interface ImportCodeGapScanDialogProps {
  api: VicCoreApi
  projectId: string
  onClose: () => void
  // Fired once the user picks content + delivery mode and confirms — the
  // caller (RequirementsScreen) runs the actual scanCodeGaps call and
  // closes this dialog itself, same "confirm intent here, caller does the
  // work" split as the rest of the Import Project dialogs.
  onConfirm: (options: ScanCodeGapsOptions) => void
}

// Structure-only pre-filter cap offered alongside 'per-file' delivery —
// not a content mode of its own (see codeOutline.ts: an outline can't
// produce REQUIREMENT: text on its own), just a way to bound how many
// files/calls a very large import turns into. Left undefined (scan every
// file) unless the user opts in.
const MAX_FILES_OPTIONS = [10, 25, 50, 100] as const

// Same placeholder rate the server's sessionTokenUsage uses (see
// MOCK_COST_PER_1K_TOKENS_USD in packages/server/src/index.ts) — z.ai's
// Coding Plan is flat-rate against an included-usage allowance, not metered
// per-token, so there is no real per-token price to quote here either. Kept
// only as a rough "if this were metered" reference, labelled accordingly.
const MOCK_COST_PER_1K_TOKENS_USD = 0.001

function estCost(tokens: number): string {
  return ((tokens / 1000) * MOCK_COST_PER_1K_TOKENS_USD).toFixed(3)
}

// Pre-flight dialog for "Scan Code for Requirement Gaps" (REQ-056). Two
// independent choices: CONTENT (send each file's complete original text,
// or a stripped version — see codeStrip.ts for what each strip toggle
// removes and why comments/bodies default off) and DELIVERY (concatenate
// every file into one call, or one call per file). GET
// /scan-code-gaps/estimate returns sizing for both content modes in one
// response (pure local computation, no LLM call/cost) so toggling either
// choice updates the shown tokens/cost immediately without a round trip,
// and "concatenate, single call" is greyed out whenever the selected
// content mode won't fit the model's context window — instead of the user
// finding out via a "Prompt 超长" / prompt-too-long 400 from the provider.
export function ImportCodeGapScanDialog({ api, projectId, onClose, onConfirm }: ImportCodeGapScanDialogProps) {
  const [estimate, setEstimate] = useState<CodeGapScanTokenEstimate | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [content, setContent] = useState<ScanCodeGapsOptions['content']>('complete')
  const [mode, setMode] = useState<ScanCodeGapsOptions['mode']>('single-call')
  const [maxFiles, setMaxFiles] = useState<number | undefined>(undefined)
  const [stripOptions, setStripOptions] = useState<CodeStripOptions>(DEFAULT_CODE_STRIP_OPTIONS)

  useEffect(() => {
    let cancelled = false
    api
      .estimateCodeGapScan(projectId, stripOptions)
      .then((result) => {
        if (cancelled) return
        setEstimate(result)
        setMode(result.complete.singleCallFits ? 'single-call' : 'per-file')
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message)
      })
    return () => {
      cancelled = true
    }
    // stripOptions intentionally included — changing a strip toggle re-fetches
    // the estimate so 'stripped' numbers reflect exactly what would be sent.
  }, [api, projectId, stripOptions])

  const activeEstimate: CodeGapScanContentEstimate | null =
    estimate && (content === 'stripped' ? estimate.stripped : estimate.complete)

  function toggleStripOption(key: keyof CodeStripOptions) {
    setStripOptions((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  function handleScan() {
    onConfirm({
      content,
      mode,
      stripOptions: content === 'stripped' ? stripOptions : undefined,
      maxFiles: mode === 'per-file' ? maxFiles : undefined,
    })
  }

  return (
    <div className="import-export-overlay" role="dialog" aria-modal="true" aria-label="Scan Code for Requirement Gaps">
      <div className="import-export-panel">
        <div className="import-export-header">
          <h1>Scan Code for Requirement Gaps</h1>
        </div>

        <p className="import-export-note">
          Estimated size of this scan, before any LLM call runs. Large imports can exceed
          the model's context window in a single call — pick content and delivery below.
          {estimate && (
            <>
              {' '}
              Model: <strong>{estimate.model ?? 'not configured'}</strong>. Context window: ~
              {estimate.contextWindow.toLocaleString()} tokens.
              {!estimate.model && (
                <>
                  {' '}
                  No LLM provider is configured for this action yet — the figure above is a generic fallback, not a
                  real model's window.
                </>
              )}
            </>
          )}
        </p>

        {error && <p className="import-export-error">{error}</p>}

        {!estimate && !error && <p className="import-export-note">Estimating…</p>}

        {estimate && activeEstimate && (
          <>
            <div
              style={{
                border: '1px solid var(--border)',
                borderRadius: 10,
                maxHeight: 220,
                overflowY: 'auto',
                marginBottom: 16,
              }}
            >
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', padding: '8px 12px', color: 'var(--text-muted)' }}>File</th>
                    <th style={{ textAlign: 'right', padding: '8px 12px', color: 'var(--text-muted)' }}>Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {activeEstimate.files.map((f) => (
                    <tr key={f.path} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: '6px 12px', color: 'var(--text-h)', wordBreak: 'break-all' }}>{f.path}</td>
                      <td style={{ padding: '6px 12px', textAlign: 'right' }}>{f.tokens.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h2 style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 8px', textTransform: 'uppercase' }}>
              Content
            </h2>
            <ul className="import-export-part-list" style={{ marginBottom: 16 }}>
              <li>
                <label>
                  <input
                    type="radio"
                    name="scan-content"
                    checked={content === 'complete'}
                    onChange={() => setContent('complete')}
                  />
                  <span>Complete code files</span>
                </label>
                <div style={{ padding: '0 12px 10px 34px', fontSize: 13, color: 'var(--text-muted)' }}>
                  Every file sent in full — most accurate, largest.
                </div>
              </li>
              <li>
                <label>
                  <input
                    type="radio"
                    name="scan-content"
                    checked={content === 'stripped'}
                    onChange={() => setContent('stripped')}
                  />
                  <span>Stripped files</span>
                </label>
                <div style={{ padding: '0 12px 10px 34px', fontSize: 13 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <input
                      type="checkbox"
                      checked={stripOptions.stripBlankLines}
                      onChange={() => toggleStripOption('stripBlankLines')}
                    />
                    <span>
                      Blank lines/whitespace <span style={{ color: 'var(--text-muted)' }}>— safe, no content lost, modest savings</span>
                    </span>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <input
                      type="checkbox"
                      checked={stripOptions.stripComments}
                      onChange={() => toggleStripOption('stripComments')}
                    />
                    <span>
                      Comments{' '}
                      <span style={{ color: 'var(--text-muted)' }}>
                        — comments often state the intended behaviour directly; removing them can hide real gaps
                      </span>
                    </span>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input
                      type="checkbox"
                      checked={stripOptions.stripBodies}
                      onChange={() => toggleStripOption('stripBodies')}
                    />
                    <span>
                      Function/method bodies (signatures only){' '}
                      <span style={{ color: 'var(--text-muted)' }}>
                        — biggest savings, but the behaviour a gap scan looks for almost always lives in the body, not the signature
                      </span>
                    </span>
                  </label>
                </div>
              </li>
            </ul>

            <h2 style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 8px', textTransform: 'uppercase' }}>
              Delivery
            </h2>
            <ul className="import-export-part-list">
              <li>
                <label>
                  <input
                    type="radio"
                    name="scan-mode"
                    checked={mode === 'single-call'}
                    disabled={!activeEstimate.singleCallFits}
                    onChange={() => setMode('single-call')}
                  />
                  <span>Concatenate complete code files, single call</span>
                  {!activeEstimate.singleCallFits && <span className="import-export-soon">Too large</span>}
                </label>
                <div style={{ padding: '0 12px 10px 34px', fontSize: 13, color: 'var(--text-muted)' }}>
                  1 call, ~{activeEstimate.singleCallTotalTokens.toLocaleString()} tokens, ~$
                  {estCost(activeEstimate.singleCallTotalTokens)} est. cost.
                </div>
              </li>
              <li>
                <label>
                  <input
                    type="radio"
                    name="scan-mode"
                    checked={mode === 'per-file'}
                    onChange={() => setMode('per-file')}
                  />
                  <span>One call per file</span>
                </label>
                <div style={{ padding: '0 12px 10px 34px', fontSize: 13, color: 'var(--text-muted)' }}>
                  {activeEstimate.perFileCallCount} call(s), ~{activeEstimate.perFileTotalTokens.toLocaleString()}{' '}
                  tokens, ~${estCost(activeEstimate.perFileTotalTokens)} est. cost.{' '}
                  <span title="z.ai's Coding Plan is flat-rate against an included-usage allowance, not metered per-token — cost figures here are a rough reference only, not a real invoiced cost.">
                    (placeholder rate)
                  </span>
                </div>
                {mode === 'per-file' && (
                  <div style={{ padding: '0 12px 10px 34px', fontSize: 13 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input
                        type="checkbox"
                        checked={maxFiles !== undefined}
                        onChange={(e) => setMaxFiles(e.target.checked ? MAX_FILES_OPTIONS[1] : undefined)}
                      />
                      Limit to the highest-signal files
                    </label>
                    {maxFiles !== undefined && (
                      <select
                        value={maxFiles}
                        onChange={(e) => setMaxFiles(Number(e.target.value))}
                        style={{ marginTop: 8, font: 'inherit', padding: '4px 8px' }}
                      >
                        {MAX_FILES_OPTIONS.map((n) => (
                          <option key={n} value={n}>
                            First {n} files (by likely business logic, generated/vendored files skipped)
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                )}
              </li>
            </ul>
          </>
        )}

        <div className="import-export-actions" style={{ gap: 8 }}>
          <button type="button" onClick={onClose} style={{ background: 'none', color: 'var(--text-h)', border: '1px solid var(--border)' }}>
            Close
          </button>
          <button type="button" disabled={!estimate} onClick={handleScan}>
            Scan
          </button>
        </div>
      </div>
    </div>
  )
}
