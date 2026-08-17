import { useEffect, useState } from 'react'
import type {
  ApplySplitRequirementResult,
  Architecture,
  Requirement,
  RequirementReferencesResult,
  SplitPieceInput,
  VicCoreApi,
} from '../api/types'
import { toOperationError } from '../api/errorCode'
import './SplitRequirementDialog.css'

interface SplitRequirementDialogProps {
  api: VicCoreApi
  projectId: string
  requirement: Requirement
  architecture: Architecture | null
  onClose: () => void
  onApplied: (result: ApplySplitRequirementResult) => void
}

// One piece being reviewed before Split is applied — starts from the
// Analyst's proposal (text + best-guess module name) but is fully
// hand-editable, same "propose then let the human correct it" pattern as
// every other LLM proposal card in this app.
interface DraftPiece {
  text: string
  architectureElementId: string | null
}

type Step = 'proposing' | 'review' | 'references' | 'applying' | 'error'

// Split Requirement (Requirements screen) — three-step flow surfaced as a
// modal dialog rather than squeezed into the narrow detail panel, since
// reviewing/editing multiple pieces plus a references report needs real
// room. Step order: propose (LLM call) -> review/edit pieces -> check
// references (mechanical, run right before commit so the report reflects
// the pieces as last edited, not stale) -> apply (mutates). The user can
// still go back and edit pieces after seeing the references report before
// committing.
export function SplitRequirementDialog({
  api,
  projectId,
  requirement,
  architecture,
  onClose,
  onApplied,
}: SplitRequirementDialogProps) {
  const [step, setStep] = useState<Step>('proposing')
  const [pieces, setPieces] = useState<DraftPiece[]>([])
  const [error, setError] = useState<string | null>(null)
  const [references, setReferences] = useState<RequirementReferencesResult | null>(null)
  const [busy, setBusy] = useState(false)

  const elements = architecture?.elements ?? []
  const elementIdByName = new Map(elements.map((e) => [e.name, e.id]))

  useEffect(() => {
    let cancelled = false
    async function propose() {
      try {
        const result = await api.proposeSplitRequirement(projectId, requirement.id)
        if (cancelled) return
        if (result.pieces.length < 2) {
          setError('The Analyst could not confidently split this requirement into two or more atomic pieces.')
          setStep('error')
          return
        }
        setPieces(
          result.pieces.map((p) => ({
            text: p.text,
            architectureElementId: p.moduleName ? (elementIdByName.get(p.moduleName) ?? null) : null,
          })),
        )
        setStep('review')
      } catch (err) {
        if (cancelled) return
        setError(toOperationError(err).error ?? 'Failed to propose a split.')
        setStep('error')
      }
    }
    propose()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function updatePieceText(index: number, text: string) {
    setPieces((prev) => prev.map((p, i) => (i === index ? { ...p, text } : p)))
  }

  function updatePieceElement(index: number, architectureElementId: string | null) {
    setPieces((prev) => prev.map((p, i) => (i === index ? { ...p, architectureElementId } : p)))
  }

  function addPiece() {
    setPieces((prev) => [...prev, { text: '', architectureElementId: null }])
  }

  function removePiece(index: number) {
    setPieces((prev) => prev.filter((_, i) => i !== index))
  }

  const validPieces = pieces.filter((p) => p.text.trim())
  const canProceed = validPieces.length >= 2

  async function handleCheckReferences() {
    if (!canProceed || busy) return
    setBusy(true)
    try {
      const result = await api.getRequirementReferences(projectId, requirement.id)
      setReferences(result)
      setStep('references')
    } catch (err) {
      setError(toOperationError(err).error ?? 'Failed to check references.')
      setStep('error')
    } finally {
      setBusy(false)
    }
  }

  async function handleApply() {
    if (!canProceed || busy) return
    setBusy(true)
    setStep('applying')
    try {
      const pieceInputs: SplitPieceInput[] = validPieces.map((p) => ({
        text: p.text.trim(),
        architectureElementId: p.architectureElementId,
      }))
      const result = await api.applySplitRequirement(projectId, requirement.id, pieceInputs)
      onApplied(result)
    } catch (err) {
      setError(toOperationError(err).error ?? 'Failed to apply the split.')
      setStep('error')
    } finally {
      setBusy(false)
    }
  }

  const totalReferenceCount =
    (references?.structuralReferences.length ?? 0) + (references?.codeReferences.length ?? 0)

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel split-dialog-panel" onClick={(e) => e.stopPropagation()}>
        <div className="requirement-detail-header">
          <span className="requirement-detail-id">Split {requirement.id}</span>
          <button type="button" className="requirement-detail-edit-btn" onClick={onClose}>
            Close
          </button>
        </div>

        <p className="split-dialog-original-text">{requirement.text}</p>

        {step === 'proposing' && <p className="split-dialog-hint">Analyst is proposing a split...</p>}

        {step === 'error' && (
          <>
            <p className="split-dialog-error">{error}</p>
            <div className="requirement-detail-edit-actions">
              <button type="button" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}

        {(step === 'review' || step === 'references') && (
          <>
            <h3 className="split-dialog-section-heading">Replacement requirements</h3>
            <ul className="split-dialog-pieces">
              {pieces.map((piece, i) => (
                <li key={i} className="split-dialog-piece">
                  <textarea
                    className="requirement-detail-edit-textarea"
                    value={piece.text}
                    onChange={(e) => updatePieceText(i, e.target.value)}
                    rows={2}
                    placeholder="Replacement requirement text"
                  />
                  <select
                    className="architecture-detail-input"
                    value={piece.architectureElementId ?? ''}
                    onChange={(e) => updatePieceElement(i, e.target.value || null)}
                  >
                    <option value="">Unallocated</option>
                    {elements.map((el) => (
                      <option key={el.id} value={el.id}>
                        {el.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="split-dialog-remove-btn"
                    onClick={() => removePiece(i)}
                    disabled={pieces.length <= 2}
                    title={pieces.length <= 2 ? 'A split needs at least two pieces' : 'Remove this piece'}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
            <button type="button" className="requirements-action-secondary" onClick={addPiece}>
              Add another piece
            </button>

            {step === 'review' && (
              <div className="requirement-detail-edit-actions">
                <button type="button" onClick={handleCheckReferences} disabled={!canProceed || busy}>
                  Check references &amp; continue
                </button>
                <button type="button" className="requirement-detail-cancel-btn" onClick={onClose} disabled={busy}>
                  Cancel
                </button>
              </div>
            )}

            {step === 'references' && references && (
              <>
                <h3 className="split-dialog-section-heading">
                  References to {requirement.id} ({totalReferenceCount})
                </h3>
                {totalReferenceCount === 0 ? (
                  <p className="split-dialog-hint">No references found — safe to remove.</p>
                ) : (
                  <>
                    <p className="split-dialog-warning">
                      {requirement.id} is referenced below. Structural links (stories, tests, conflicts) will be
                      updated automatically to point at the new requirements. Free-text mentions (notes, generated
                      code comments) will NOT be rewritten — review these afterwards.
                    </p>
                    {references.structuralReferences.length > 0 && (
                      <ul className="split-dialog-references">
                        {references.structuralReferences.map((ref, i) => (
                          <li key={i}>
                            <span className={`split-dialog-ref-badge split-dialog-ref-badge-${ref.kind}`}>
                              {ref.kind.includes('mention') ? 'text mention' : 'structural'}
                            </span>
                            {ref.label}
                          </li>
                        ))}
                      </ul>
                    )}
                    {references.codeReferences.length > 0 && (
                      <ul className="split-dialog-references">
                        {references.codeReferences.map((ref, i) => (
                          <li key={i}>
                            <span className="split-dialog-ref-badge split-dialog-ref-badge-code-mention">
                              code mention
                            </span>
                            {ref.relativePath} (line{ref.lines.length > 1 ? 's' : ''} {ref.lines.join(', ')})
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
                <div className="requirement-detail-edit-actions">
                  <button type="button" onClick={handleApply} disabled={!canProceed || busy}>
                    Apply split
                  </button>
                  <button
                    type="button"
                    className="requirement-detail-cancel-btn"
                    onClick={() => setStep('review')}
                    disabled={busy}
                  >
                    Back
                  </button>
                </div>
              </>
            )}
          </>
        )}

        {step === 'applying' && <p className="split-dialog-hint">Applying split...</p>}
      </div>
    </div>
  )
}
