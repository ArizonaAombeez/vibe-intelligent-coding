import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectSummary, VicCoreApi } from '../api/types'
import './LandingScreen.css'

interface LandingScreenProps {
  api: VicCoreApi
  onOpenProject: (id: string) => void
  onCreateProject: (name: string, mode?: 'new' | 'import') => void
  onOpenSettings: () => void
}

export function LandingScreen({
  api,
  onOpenProject,
  onCreateProject,
  onOpenSettings,
}: LandingScreenProps) {
  const [recentProjects, setRecentProjects] = useState<ProjectSummary[]>([])
  // Kept separate from recentProjects (rather than a single union state) so
  // a failed fetch and a genuinely empty project list render differently —
  // listRecentProjects() used to have no .catch() at all, so a backend
  // that's offline silently looked identical to "no projects yet".
  const [loadError, setLoadError] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)

  const loadProjects = useCallback(() => {
    setLoadError(null)
    api
      .listRecentProjects()
      .then(setRecentProjects)
      .catch((err: unknown) => setLoadError((err as Error).message || 'Could not reach the server'))
  }, [api])

  useEffect(() => {
    loadProjects()
  }, [loadProjects])

  useEffect(() => {
    if (renamingId) renameInputRef.current?.focus()
  }, [renamingId])

  function startRename(project: ProjectSummary) {
    setRenamingId(project.id)
    setRenameValue(project.name)
  }

  async function commitRename(id: string) {
    const name = renameValue.trim()
    setRenamingId(null)
    if (!name) return
    const updated = await api.renameProject(id, name)
    setRecentProjects((prev) => prev.map((p) => (p.id === id ? updated : p)))
  }

  async function handleDelete(project: ProjectSummary) {
    if (!window.confirm(`Delete project "${project.name}"? This cannot be undone.`)) return
    await api.deleteProject(project.id)
    setRecentProjects((prev) => prev.filter((p) => p.id !== project.id))
  }

  return (
    <div className="landing-screen">
      <div className="landing-content">
        <h1>VIC</h1>
        <p className="landing-tagline">Vibe Intelligent Coding</p>

        <div className="landing-actions">
          <button
            type="button"
            className="landing-action primary"
            onClick={() => onCreateProject('Untitled Project', 'new')}
          >
            New Project
          </button>
          <button
            type="button"
            className="landing-action"
            onClick={() => onCreateProject('Untitled Project', 'import')}
            title="Reverse-engineer requirements and architecture from an existing codebase."
          >
            Import Project
          </button>
        </div>

        <div className="recent-projects">
          <h2>Recent Projects</h2>
          {loadError ? (
            <div className="recent-offline">
              <p className="recent-offline-message">VIC server is offline: {loadError}</p>
              <button type="button" onClick={loadProjects}>
                Retry
              </button>
            </div>
          ) : recentProjects.length === 0 ? (
            <p className="recent-empty">No recent projects.</p>
          ) : (
            <ul>
              {recentProjects.map((project) => (
                <li key={project.id}>
                  <div className="recent-row">
                    {renamingId === project.id ? (
                      <input
                        ref={renameInputRef}
                        type="text"
                        className="recent-rename-input"
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={() => commitRename(project.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitRename(project.id)
                          else if (e.key === 'Escape') setRenamingId(null)
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        className="recent-open-button"
                        onClick={() => onOpenProject(project.id)}
                      >
                        <span className="recent-name">{project.name}</span>
                        <span className="recent-date">
                          {new Date(project.lastOpenedAt).toLocaleDateString()}
                        </span>
                      </button>
                    )}
                    <button
                      type="button"
                      className="recent-row-action"
                      title="Rename project"
                      aria-label="Rename project"
                      onClick={() => startRename(project)}
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      className="recent-row-action recent-row-action-delete"
                      title="Delete project"
                      aria-label="Delete project"
                      onClick={() => handleDelete(project)}
                    >
                      🗑
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <button type="button" className="landing-settings-link" onClick={onOpenSettings}>
          Settings
        </button>
      </div>
    </div>
  )
}
