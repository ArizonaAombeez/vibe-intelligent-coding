import type { AnalyseResult, ConflictPair } from '../api/types'
import { QUALITY_SCORE_COLOR } from '../statusColor'
import { highlightRequirementIds } from './requirementIdHighlight'
import { EditableProposalCard } from './EditableProposalCard'
import './RequirementResultsPanel.css'

interface RequirementResultsPanelProps {
  widthPercent: number
  onResizeStart: (e: React.MouseEvent) => void
  analysisResults: AnalyseResult[]
  conflictsChecked: boolean
  conflictPairs: ConflictPair[]
  gapSuggestions: string[]
  checkingGaps: boolean
  // Both accept callbacks receive the (possibly human-edited) text plus the
  // original suggestion text, so the caller can filter the right entry out
  // of its suggestion list regardless of what was edited.
  onAcceptGap: (text: string, originalText: string) => void
  onDiscardGap: (text: string) => void
  // Code gap scan (Import Project, REQ-056) — proposals for requirements
  // the imported codebase implies but that aren't yet covered by any
  // confirmed requirement. Same accept/discard shape as gapSuggestions
  // above, kept as a separate section/list since it comes from a distinct
  // action (Scan Code for Requirement Gaps) with its own provenance
  // ('reverse-elicited-code' vs. gapSuggestions' plain 'human').
  codeGapSuggestions: string[]
  scanningCodeGaps: boolean
  onAcceptCodeGap: (text: string, originalText: string) => void
  onDiscardCodeGap: (text: string) => void
  onBackToDetail: () => void
  hasOpenRequirement: boolean
}

export function RequirementResultsPanel({
  widthPercent,
  onResizeStart,
  analysisResults,
  conflictsChecked,
  conflictPairs,
  gapSuggestions,
  checkingGaps,
  onAcceptGap,
  onDiscardGap,
  codeGapSuggestions,
  scanningCodeGaps,
  onAcceptCodeGap,
  onDiscardCodeGap,
  onBackToDetail,
  hasOpenRequirement,
}: RequirementResultsPanelProps) {
  return (
    <div className="requirement-results-panel" style={{ flexBasis: `${widthPercent}%` }}>
      <div className="requirement-detail-resize-handle" onMouseDown={onResizeStart} />
      <div className="requirement-results-panel-content">
        <div className="requirement-detail-header">
          <span className="requirement-detail-id">Analysis results</span>
          {hasOpenRequirement && (
            <button type="button" className="requirement-detail-edit-btn" onClick={onBackToDetail}>
              Back to requirement
            </button>
          )}
        </div>

        {analysisResults.length > 0 && (
          <section className="requirement-detail-section">
            <h3>Clarity review results</h3>
            {analysisResults.map((result) => (
              <div key={result.requirementId} className="analysis-result-card">
                <span className="req-id-highlight">{result.requirementId}</span>
                <span
                  className="quality-score-badge"
                  style={{ background: QUALITY_SCORE_COLOR(result.qualityScore.score) }}
                >
                  {result.qualityScore.score}
                </span>
                <p>{highlightRequirementIds(result.note)}</p>
              </div>
            ))}
          </section>
        )}

        {conflictsChecked && (
          <section className="requirement-detail-section">
            <h3>Conflict check results</h3>
            {conflictPairs.length === 0 ? (
              <p className="requirements-check-empty">No conflicts found.</p>
            ) : (
              conflictPairs.map((pair, i) => (
                <div key={i} className="analysis-result-card">
                  <span className="req-id-highlight">{pair.requirementIds[0]}</span>{' '}
                  <span className="req-id-highlight">{pair.requirementIds[1]}</span>
                  <p>{highlightRequirementIds(pair.rationale)}</p>
                </div>
              ))
            )}
          </section>
        )}

        {(gapSuggestions.length > 0 || checkingGaps) && (
          <section className="requirement-detail-section">
            <h3>Gap check suggestions</h3>
            {gapSuggestions.length === 0 && !checkingGaps && (
              <p className="requirements-check-empty">No gaps found.</p>
            )}
            {gapSuggestions.map((text) => (
              <EditableProposalCard
                key={text}
                text={text}
                onAccept={(edited) => onAcceptGap(edited, text)}
                onDiscard={onDiscardGap}
              />
            ))}
          </section>
        )}

        {(codeGapSuggestions.length > 0 || scanningCodeGaps) && (
          <section className="requirement-detail-section">
            <h3>Code gap scan suggestions</h3>
            {codeGapSuggestions.length === 0 && !scanningCodeGaps && (
              <p className="requirements-check-empty">No gaps found.</p>
            )}
            {codeGapSuggestions.map((text) => (
              <EditableProposalCard
                key={text}
                text={text}
                onAccept={(edited) => onAcceptCodeGap(edited, text)}
                onDiscard={onDiscardCodeGap}
              />
            ))}
          </section>
        )}

        {analysisResults.length === 0 &&
          !conflictsChecked &&
          gapSuggestions.length === 0 &&
          !checkingGaps &&
          codeGapSuggestions.length === 0 &&
          !scanningCodeGaps && <p className="requirements-check-empty">No analysis run yet.</p>}
      </div>
    </div>
  )
}
