import { useEffect, useRef, useState } from 'react'
import type { ProjectPartId, ProjectPartInfo, VicCoreApi } from '../api/types'
import './ImportExportDialog.css'

interface ImportExportDialogProps {
  api: VicCoreApi
  projectId: string
  onClose: () => void
}

type Mode = 'export' | 'import'

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

// File > Export.../Import... (Area G) — lets the user pick which project
// parts (Requirements, Architecture, ...) to include, then either
// downloads a .zip of the selected parts or applies an uploaded .zip's
// matching parts into the current project. Both actions share one dialog
// (with a mode toggle) since they use the same checkbox list.
export function ImportExportDialog({ api, projectId, onClose }: ImportExportDialogProps) {
  const [mode, setMode] = useState<Mode>('export')
  const [parts, setParts] = useState<ProjectPartInfo[]>([])
  const [selected, setSelected] = useState<Set<ProjectPartId>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    api.listProjectParts().then((loaded) => {
      setParts(loaded)
      setSelected(new Set(loaded.filter((p) => p.available).map((p) => p.id)))
    })
  }, [api])

  function togglePart(id: ProjectPartId) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function switchMode(next: Mode) {
    setMode(next)
    setError(null)
    setResult(null)
    setPendingFile(null)
  }

  async function handleExport() {
    if (selected.size === 0 || busy) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const { blob, filename } = await api.exportProjectParts(projectId, Array.from(selected))
      triggerBrowserDownload(blob, filename)
      setResult(`Exported ${filename}`)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function handleImport() {
    if (selected.size === 0 || !pendingFile || busy) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const counts = await api.importProjectParts(projectId, Array.from(selected), pendingFile)
      const summary = Object.entries(counts)
        .map(([partId, count]) => `${count} ${parts.find((p) => p.id === partId)?.label ?? partId}`)
        .join(', ')
      setResult(summary ? `Imported ${summary}` : 'No matching parts were found in that file')
      setPendingFile(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const availableSelectedCount = Array.from(selected).filter(
    (id) => parts.find((p) => p.id === id)?.available,
  ).length

  return (
    <div className="import-export-overlay" role="dialog" aria-modal="true" aria-label="Import / Export">
      <div className="import-export-panel">
        <div className="import-export-header">
          <h1>Import / Export</h1>
          <button type="button" className="import-export-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="import-export-mode-toggle" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'export'}
            className={mode === 'export' ? 'active' : ''}
            onClick={() => switchMode('export')}
          >
            Export
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'import'}
            className={mode === 'import' ? 'active' : ''}
            onClick={() => switchMode('import')}
          >
            Import
          </button>
        </div>

        <p className="import-export-note">
          {mode === 'export'
            ? 'Choose which parts of this project to include. Each selected part is saved as its own JSON file inside one downloaded .zip.'
            : 'Choose which parts to apply from an exported .zip. Imported items are merged into this project — ids are prefixed (e.g. IMP_REQ-001) so they never collide with existing ones.'}
        </p>

        <ul className="import-export-part-list">
          {parts.map((part) => (
            <li key={part.id}>
              <label className={part.available ? '' : 'disabled'}>
                <input
                  type="checkbox"
                  checked={selected.has(part.id)}
                  disabled={!part.available}
                  onChange={() => togglePart(part.id)}
                />
                <span>{part.label}</span>
                {!part.available && <span className="import-export-soon">No data yet</span>}
              </label>
            </li>
          ))}
        </ul>

        {mode === 'import' && (
          <div className="import-export-file-row">
            <input
              ref={fileInputRef}
              type="file"
              accept=".zip,application/zip"
              onChange={(e) => setPendingFile(e.target.files?.[0] ?? null)}
            />
          </div>
        )}

        {error && <p className="import-export-error">{error}</p>}
        {result && <p className="import-export-result">{result}</p>}

        <div className="import-export-actions">
          {mode === 'export' ? (
            <button type="button" disabled={availableSelectedCount === 0 || busy} onClick={handleExport}>
              {busy ? 'Exporting…' : 'Export'}
            </button>
          ) : (
            <button
              type="button"
              disabled={availableSelectedCount === 0 || !pendingFile || busy}
              onClick={handleImport}
            >
              {busy ? 'Importing…' : 'Import'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
