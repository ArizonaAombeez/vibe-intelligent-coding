import { useEffect, useRef, useState } from 'react'
import type { PhaseId, PhaseInfo, VicCoreApi } from '../api/types'
import './DashboardScreen.css'

interface DashboardScreenProps {
  api: VicCoreApi
  projectId: string
  projectName: string
  phases: PhaseInfo[]
  onSelectPhase: (id: PhaseId) => void
  onRenameProject: (name: string) => void
}

// defaultPhases() (httpApi.ts) deliberately omits a 'planning' PhaseInfo
// entry — that's (one of) the mechanisms that hides Planning from the top
// nav. The Dashboard's Planning stat tile is kept working regardless (per
// the hide-not-delete migration: "there's no reason to remove a working,
// correct stat tile just because its source phase is hidden from nav"), so
// its card is rendered directly below rather than derived from the phases
// prop. Unlike the other cards it's rendered non-clickable (no
// onSelectPhase call) — decision 1 of the migration is explicit that
// Planning must have "no way to get to it by clicking around the app," so
// the stat NUMBERS stay visible but this card can't be used as a
// navigation path into PlanningScreen the way the other cards navigate
// into their phase.

// Tone drives the color a stat renders in. It's derived only from the
// number itself (e.g. "2 failing" -> critical, "5 of 5 passing" -> good) —
// never fabricated, and distinct from PhaseInfo.status (the hardcoded
// stub removed earlier) which this screen no longer reads.
type StatTone = 'good' | 'warning' | 'critical' | 'neutral'

interface Stat {
  label: string
  value: string
  tone: StatTone
}

type DomainStats = Partial<Record<PhaseId, Stat[]>>

function ratioTone(part: number, total: number): StatTone {
  if (total === 0) return 'neutral'
  if (part === total) return 'good'
  if (part === 0) return 'critical'
  return 'warning'
}

export function DashboardScreen({
  api,
  projectId,
  projectName,
  phases,
  onSelectPhase,
  onRenameProject,
}: DashboardScreenProps) {
  const pipelinePhases = phases.filter((p) => p.id !== 'dashboard')
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(projectName)
  const [stats, setStats] = useState<DomainStats>({})
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renaming) inputRef.current?.focus()
  }, [renaming])

  useEffect(() => {
    let cancelled = false

    async function load() {
      const [requirements, architecture, backlog, testSuite, codingRuns, testRuns, regressionRuns] =
        await Promise.all([
          api.listRequirements(projectId),
          api.getArchitecture(projectId),
          api.getBacklog(projectId),
          api.getTestSuite(projectId),
          api.listCodingRuns(projectId),
          api.listTestRuns(projectId),
          api.listTestRegressionRuns(projectId),
        ])
      if (cancelled) return

      const next: DomainStats = {}

      // Requirements
      {
        const total = requirements.length
        const complete = requirements.filter((r) => r.status === 'complete').length
        const withConflicts = requirements.filter((r) => (r.conflicts?.length ?? 0) > 0).length
        const scored = requirements.filter((r) => r.qualityScore)
        const stats: Stat[] = [{ label: 'requirements', value: `${total}`, tone: 'neutral' }]
        if (total > 0) {
          stats.push({ label: 'complete', value: `${complete} / ${total}`, tone: ratioTone(complete, total) })
        }
        if (scored.length > 0) {
          const avg = scored.reduce((sum, r) => sum + (r.qualityScore?.score ?? 0), 0) / scored.length
          stats.push({
            label: 'avg quality score',
            value: `${avg.toFixed(1)} / 5`,
            tone: avg >= 4 ? 'good' : avg >= 3 ? 'warning' : 'critical',
          })
        }
        if (withConflicts > 0) {
          stats.push({ label: 'with unresolved conflicts', value: `${withConflicts}`, tone: 'critical' })
        }
        next.requirements = stats
      }

      // Architecture
      if (architecture) {
        const elementCount = architecture.elements.length
        const allocated = requirements.filter((r) => r.architectureElements.length > 0).length
        const contractTotal = architecture.interfaceContracts?.length ?? 0
        const staleContracts = (architecture.interfaceContracts ?? []).filter(
          (c) => c.status === 'stale',
        ).length
        const conflicts = architecture.conflicts?.length ?? 0
        const stats: Stat[] = [{ label: 'elements', value: `${elementCount}`, tone: 'neutral' }]
        if (requirements.length > 0) {
          stats.push({
            label: 'requirements allocated',
            value: `${allocated} / ${requirements.length}`,
            tone: ratioTone(allocated, requirements.length),
          })
        }
        if (contractTotal > 0) {
          const defined = contractTotal - staleContracts
          stats.push({
            label: 'interface contracts current',
            value: `${defined} / ${contractTotal}`,
            tone: ratioTone(defined, contractTotal),
          })
        }
        if (conflicts > 0) {
          stats.push({ label: 'unresolved conflicts', value: `${conflicts}`, tone: 'critical' })
        }
        next.architecture = stats
      } else {
        next.architecture = [{ label: 'status', value: 'Not started', tone: 'neutral' }]
      }

      // Planning
      if (backlog) {
        const stories = backlog.stories.filter((s) => !s.deletedAt)
        const total = stories.length
        const done = stories.filter((s) => s.status === 'complete').length
        const inProgress = stories.filter((s) => s.status === 'in-progress').length
        const conflicts = backlog.conflicts?.length ?? 0
        const stats: Stat[] = [{ label: 'stories', value: `${total}`, tone: 'neutral' }]
        if (total > 0) {
          stats.push({ label: 'complete', value: `${done} / ${total}`, tone: ratioTone(done, total) })
          if (inProgress > 0) {
            stats.push({ label: 'in progress', value: `${inProgress}`, tone: 'warning' })
          }
        }
        if (conflicts > 0) {
          stats.push({ label: 'sequencing conflicts', value: `${conflicts}`, tone: 'critical' })
        }
        next.planning = stats
      } else {
        next.planning = [{ label: 'status', value: 'Not started', tone: 'neutral' }]
      }

      // Coding
      {
        const total = codingRuns.length
        const successes = codingRuns.filter((r) => r.status === 'success')
        const failed = total - successes.length
        const stats: Stat[] = [{ label: 'coding runs', value: `${total}`, tone: 'neutral' }]
        if (total > 0) {
          stats.push({
            label: 'succeeded',
            value: `${successes.length} / ${total}`,
            tone: ratioTone(successes.length, total),
          })
          if (failed > 0) {
            stats.push({ label: 'rejected / failed', value: `${failed}`, tone: 'critical' })
          }
        }
        // Live "elements fully coded" metric (replaces the old
        // backlog-derived "stories coded" sub-metric, since Coding no
        // longer reads Story/Backlog at all) — elements whose allocated
        // requirements are all 'coded'-or-later, out of elements with any
        // allocated requirement at all.
        const elementIdsWithAllocation = new Set(requirements.flatMap((r) => r.architectureElements))
        const codedStatuses = new Set(['coded', 'tested', 'complete'])
        let elementsFullyCoded = 0
        for (const elementId of elementIdsWithAllocation) {
          const allocated = requirements.filter((r) => r.architectureElements.includes(elementId))
          if (allocated.length > 0 && allocated.every((r) => codedStatuses.has(r.status))) {
            elementsFullyCoded++
          }
        }
        if (elementIdsWithAllocation.size > 0) {
          stats.push({
            label: 'elements fully coded',
            value: `${elementsFullyCoded} / ${elementIdsWithAllocation.size}`,
            tone: ratioTone(elementsFullyCoded, elementIdsWithAllocation.size),
          })
        }
        next.coding = stats
      }

      // Test Creation
      if (testSuite) {
        const tests = testSuite.tests.filter((t) => !t.deletedAt)
        const total = tests.length
        const traced = tests.filter((t) => t.requirementIds.length > 0).length
        const stats: Stat[] = [{ label: 'tests', value: `${total}`, tone: 'neutral' }]
        if (total > 0) {
          stats.push({
            label: 'traced to requirements',
            value: `${traced} / ${total}`,
            tone: ratioTone(traced, total),
          })
        }
        next['test-creation'] = stats
      } else {
        next['test-creation'] = [{ label: 'status', value: 'Not started', tone: 'neutral' }]
      }

      // Test Execution
      {
        const stats: Stat[] = []
        if (testRuns.length > 0) {
          const latest = testRuns.reduce((a, b) => (a.finishedAt > b.finishedAt ? a : b))
          const passed = latest.outcomes.filter((o) => o.passed).length
          const total = latest.outcomes.length
          stats.push({
            label: 'last run passing',
            value: `${passed} / ${total}`,
            tone: ratioTone(passed, total),
          })
          stats.push({ label: 'runs recorded', value: `${testRuns.length}`, tone: 'neutral' })
          if (latest.mutationScore) {
            const pct = latest.mutationScore.percentage
            stats.push({
              label: 'mutation score',
              value: `${pct.toFixed(0)}%`,
              tone: pct >= 80 ? 'good' : pct >= 50 ? 'warning' : 'critical',
            })
          }
        } else {
          stats.push({ label: 'status', value: 'No runs yet', tone: 'neutral' })
        }
        if (regressionRuns.length > 0) {
          const passing = regressionRuns.filter((r) => r.allPassed).length
          stats.push({
            label: 'regression runs all-passing',
            value: `${passing} / ${regressionRuns.length}`,
            tone: ratioTone(passing, regressionRuns.length),
          })
        }
        next['test-execution'] = stats
      }

      setStats(next)
    }

    load().catch(() => {
      if (!cancelled) setStats({})
    })

    return () => {
      cancelled = true
    }
  }, [api, projectId])

  function startRename() {
    setRenameValue(projectName)
    setRenaming(true)
  }

  function commitRename() {
    setRenaming(false)
    const name = renameValue.trim()
    if (name && name !== projectName) onRenameProject(name)
  }

  return (
    <div className="dashboard-screen">
      {renaming ? (
        <input
          ref={inputRef}
          type="text"
          className="dashboard-title-input"
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename()
            else if (e.key === 'Escape') setRenaming(false)
          }}
        />
      ) : (
        <h1 className="dashboard-title" onClick={startRename} title="Click to rename">
          {projectName}
          <span className="dashboard-title-edit-icon">✎</span>
        </h1>
      )}
      <p className="dashboard-subtitle">Project overview</p>

      <div className="dashboard-grid">
        {(() => {
          const phaseStats = stats.planning
          return (
            <div
              key="planning"
              className="dashboard-card dashboard-card-static"
              title="Planning is hidden from navigation, but its data and stats still exist."
            >
              <div className="dashboard-card-header">
                <span className="dashboard-card-title">Planning</span>
              </div>
              {phaseStats && phaseStats.length > 0 && (
                <dl className="dashboard-card-stats">
                  {phaseStats.map((stat, i) => (
                    <div className={`dashboard-stat tone-${stat.tone}`} key={i}>
                      <dt className="dashboard-stat-label">{stat.label}</dt>
                      <dd className="dashboard-stat-value">{stat.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          )
        })()}
        {pipelinePhases.map((phase) => {
          const phaseStats = stats[phase.id]
          return (
            <button
              key={phase.id}
              type="button"
              className="dashboard-card"
              onClick={() => onSelectPhase(phase.id)}
            >
              <div className="dashboard-card-header">
                <span className="dashboard-card-title">{phase.label}</span>
              </div>
              {phase.substeps.length > 0 && (
                <ul className="dashboard-card-substeps">
                  {phase.substeps.map((substep) => (
                    <li key={substep.id}>{substep.label}</li>
                  ))}
                </ul>
              )}
              {phaseStats && phaseStats.length > 0 && (
                <dl className="dashboard-card-stats">
                  {phaseStats.map((stat, i) => (
                    <div className={`dashboard-stat tone-${stat.tone}`} key={i}>
                      <dt className="dashboard-stat-label">{stat.label}</dt>
                      <dd className="dashboard-stat-value">{stat.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
