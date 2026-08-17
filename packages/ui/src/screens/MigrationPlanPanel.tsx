import { useEffect, useState } from 'react'
import type { CurrentOperation, MigrationPlanRecord, VicCoreApi } from '../api/types'
import { toOperationError } from '../api/errorCode'
import './PlanningScreen.css'

// Additive extraction of PlanningScreen.tsx's MigrationPlanView — a COPY of
// that component's JSX/logic, not a move. This is Import Project's Area G
// migration-plan feature (confirmed unrelated to Story/Backlog/Planning),
// made reachable a second way: from ArchitectureScreen.tsx for import-mode
// projects, per the hide-not-delete migration's decision 6. PlanningScreen
// itself keeps its own copy of this view too (still reachable there in
// principle, just no longer linked from the nav) — duplication here is the
// correct tradeoff for "don't touch working Planning code": editing
// PlanningScreen.tsx to extract/share this instead would have modified a
// file the migration plan requires stay byte-for-byte unchanged.
interface MigrationPlanPanelProps {
  api: VicCoreApi
  projectId: string
  onOperationChange: (op: CurrentOperation) => void
}

// Plain labeled badges rather than STATUS_COLOR — MigrationAction
// (reuse-as-is/refactor-in-place/rewrite) doesn't map cleanly onto the
// existing not-started/in-progress/blocked/complete lifecycle scale.
const ACTION_LABEL: Record<MigrationPlanRecord['stories'][number]['action'], string> = {
  'reuse-as-is': 'Reuse as-is',
  'refactor-in-place': 'Refactor in place',
  rewrite: 'Rewrite',
}

export function MigrationPlanPanel({ api, projectId, onOperationChange }: MigrationPlanPanelProps) {
  const [generating, setGenerating] = useState(false)
  const [plan, setPlan] = useState<MigrationPlanRecord | null>(null)
  const [elementNameById, setElementNameById] = useState<Map<string, string>>(new Map())

  useEffect(() => {
    let cancelled = false
    api.getArchitecture(projectId).then((arch) => {
      if (cancelled || !arch) return
      setElementNameById(new Map(arch.elements.map((e) => [e.id, e.name])))
    })
    return () => {
      cancelled = true
    }
  }, [api, projectId])

  async function handleGenerate() {
    if (generating) return
    setGenerating(true)
    onOperationChange({ text: 'Generating migration plan...' })
    try {
      const result = await api.generateMigrationPlan(projectId)
      setPlan(result)
      onOperationChange({ text: null })
    } catch (err) {
      onOperationChange(toOperationError(err))
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div className="planning-screen">
      <h1>Migration Plan</h1>
      <p className="planning-screen-hint">
        Generates one migration story per architecture element, derived from the most recent code
        alignment analysis — run Analyze Code Alignment above first if this button stays disabled.
      </p>

      <div className="planning-action-bar">
        <button type="button" onClick={handleGenerate} disabled={generating}>
          {generating ? 'Generating...' : 'Generate Migration Plan'}
        </button>
      </div>

      {plan && (
        <ul className="planning-story-list">
          {plan.stories.map((story) => (
            <li key={story.id} className="planning-story-card">
              <div className="planning-story-header">
                <span className="planning-story-element">
                  {elementNameById.get(story.architectureElementId) ?? story.architectureElementId}
                </span>
                <span className={`planning-action-badge planning-action-badge-${story.action}`}>
                  {ACTION_LABEL[story.action]}
                </span>
              </div>
              <p className="planning-story-rationale">{story.rationale}</p>
            </li>
          ))}
        </ul>
      )}

      {plan && plan.stories.length === 0 && (
        <p className="planning-screen-hint">No stories yet — no architecture elements found.</p>
      )}
    </div>
  )
}
