import { useState } from 'react'
import type { ImportProjectPreview, VicCoreApi } from '../api/types'
import './ImportExportDialog.css'

interface ImportCodebaseDialogProps {
  api: VicCoreApi
  projectId: string
  onClose: () => void
  // Fired once Save succeeds — the result mirrors the preview stats (Save
  // reproduces exactly what Import already computed), so the caller can
  // unconditionally mark importedCodePresent and refresh the requirement
  // list if anything was actually imported.
  onImported: (result: ImportProjectPreview) => void
}

type RequirementsFormat = 'vic-export' | 'vic-tagged'

// Import Project (REQ-055) — points VIC at up to three independent
// server-side locations (code, requirements, architecture may each live
// somewhere different) and lets the user opt into importing
// Requirements/Architecture already in one of VIC's own formats. Two-step
// interaction: Import previews (reads + parses + computes counts, commits
// nothing), then Save commits exactly what was previewed. Closing the
// dialog after Import but before Save discards the preview — nothing
// partial lands in the project. Every import option is a deterministic,
// non-LLM parse of an exact expected format — nothing is proposed or
// inferred, so there is no accept/discard review step in this dialog.
// Reverse-elicitation-style proposals only happen later, via the separate,
// explicitly user-triggered "Scan Code for Requirement Gaps" action
// (RequirementsScreen) once the user is ready.
export function ImportCodebaseDialog({ api, projectId, onClose, onImported }: ImportCodebaseDialogProps) {
  const [codePath, setCodePath] = useState('')
  const [importRequirementsChecked, setImportRequirementsChecked] = useState(true)
  const [requirementsFormat, setRequirementsFormat] = useState<RequirementsFormat>('vic-export')
  const [requirementsPath, setRequirementsPath] = useState('')
  const [importArchitecture, setImportArchitecture] = useState(true)
  const [architecturePath, setArchitecturePath] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<ImportProjectPreview | null>(null)
  const [saved, setSaved] = useState(false)

  const hasAnyPath =
    codePath.trim() || (importRequirementsChecked && requirementsPath.trim()) || (importArchitecture && architecturePath.trim())

  async function handleImport() {
    if (!hasAnyPath || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await api.previewImportProject(projectId, {
        codePath: codePath.trim() || null,
        requirementsPath: importRequirementsChecked && requirementsPath.trim() ? requirementsPath.trim() : null,
        requirementsFormat: importRequirementsChecked && requirementsPath.trim() ? requirementsFormat : null,
        architecturePath: importArchitecture && architecturePath.trim() ? architecturePath.trim() : null,
      })
      setPreview(result)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function handleSave() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await api.saveImportProject(projectId)
      setSaved(true)
      onImported(result)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function handleClose() {
    if (preview && !saved) {
      await api.discardPendingImport(projectId).catch(() => {})
    }
    onClose()
  }

  return (
    <div className="import-export-overlay" role="dialog" aria-modal="true" aria-label="Import Project">
      <div className="import-export-panel">
        <div className="import-export-header">
          <h1>Import Project</h1>
          <button type="button" className="import-export-close" onClick={handleClose} aria-label="Close">
            ×
          </button>
        </div>

        <p className="import-export-note">
          Each location is a path on the machine running the VIC server — code,
          requirements, and architecture may live in different places. Import previews
          what would be brought in; nothing is committed until you Save.
        </p>

        <div className="import-export-file-row">
          <label style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>Code folder</label>
          <input
            type="text"
            value={codePath}
            onChange={(e) => setCodePath(e.target.value)}
            disabled={preview !== null}
            placeholder="C:\Projects\MyExistingApp"
            style={{ width: '100%', font: 'inherit', padding: '8px 10px' }}
          />
        </div>

        <ul className="import-export-part-list">
          <li>
            <label>
              <input
                type="checkbox"
                checked={importRequirementsChecked}
                disabled={preview !== null}
                onChange={(e) => setImportRequirementsChecked(e.target.checked)}
              />
              <span>Requirements</span>
            </label>
            {importRequirementsChecked && (
              <div style={{ padding: '0 12px 10px 34px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                  <input
                    type="radio"
                    name="requirements-format"
                    checked={requirementsFormat === 'vic-export'}
                    disabled={preview !== null}
                    onChange={() => setRequirementsFormat('vic-export')}
                  />
                  Previously exported from VIC (requirements.json)
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                  <input
                    type="radio"
                    name="requirements-format"
                    checked={requirementsFormat === 'vic-tagged'}
                    disabled={preview !== null}
                    onChange={() => setRequirementsFormat('vic-tagged')}
                  />
                  VIC tagged text file(s)
                </label>
                <input
                  type="text"
                  value={requirementsPath}
                  onChange={(e) => setRequirementsPath(e.target.value)}
                  disabled={preview !== null}
                  placeholder={
                    requirementsFormat === 'vic-export'
                      ? 'C:\\Exports\\requirements.json'
                      : 'C:\\Docs\\requirements.txt or a folder to scan'
                  }
                  style={{ width: '100%', font: 'inherit', padding: '6px 8px' }}
                />
              </div>
            )}
          </li>
          <li>
            <label>
              <input
                type="checkbox"
                checked={importArchitecture}
                disabled={preview !== null}
                onChange={(e) => setImportArchitecture(e.target.checked)}
              />
              <span>Architecture</span>
            </label>
            {importArchitecture && (
              <div style={{ padding: '0 12px 10px 34px' }}>
                <input
                  type="text"
                  value={architecturePath}
                  onChange={(e) => setArchitecturePath(e.target.value)}
                  disabled={preview !== null}
                  placeholder="C:\Exports\architecture.json"
                  style={{ width: '100%', font: 'inherit', padding: '6px 8px' }}
                />
              </div>
            )}
          </li>
          <li>
            <label className="disabled">
              <input type="checkbox" disabled />
              <span>Test Cases</span>
              <span className="import-export-soon">No data yet</span>
            </label>
          </li>
        </ul>

        {error && <p className="import-export-error">{error}</p>}
        {preview && (
          <p className="import-export-result">
            {preview.codeFileCount} code file(s) stored, {preview.requirementsImportedCount} requirement(s) imported,{' '}
            {preview.architectureImportedCount} architecture element(s) imported.
            {!saved && ' Review the counts above, then Save to commit — or close this dialog to discard.'}
          </p>
        )}

        <div className="import-export-actions">
          {saved ? (
            <button type="button" onClick={onClose}>
              Done
            </button>
          ) : preview ? (
            <button type="button" disabled={busy} onClick={handleSave}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          ) : (
            <button type="button" disabled={!hasAnyPath || busy} onClick={handleImport}>
              {busy ? 'Importing…' : 'Import'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
