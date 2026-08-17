import { useEffect, useMemo, useRef, useState } from 'react'
import type { Architecture, Requirement } from '../api/types'
import { REQUIREMENT_STATUS_LABEL, STATUS_COLOR } from '../statusColor'
import './ArchitectureRequirementList.css'

const UNALLOCATED_GROUP = 'Unallocated to Architecture'

interface ArchitectureRequirementListProps {
  requirements: Requirement[]
  architecture: Architecture
  statusByRequirementId: Map<string, 'not-started' | 'in-progress' | 'blocked' | 'complete'>
  expandedRequirementId: string | null
  onExpandedRequirementIdChange: (requirementId: string | null) => void
  draggingRequirementId: string | null
  onDragStart: (requirementId: string) => void
  onDragEnd: () => void
  onSaveRationale: (requirementId: string, rationale: string) => Promise<void>
  // The diagram's currently-selected element id (or null) — its group
  // (elementId, or UNALLOCATED_GROUP when null but something is selected)
  // is force-expanded and scrolled into view, mirroring the main
  // Requirements screen's grouping but driven by diagram selection instead
  // of manual expand/collapse only.
  activeElementId: string | null
}

// One row per requirement, in-place expandable (animated max-height) to show
// its allocation state and let the allocation rationale be edited — mirrors
// the main Requirements screen's row shape but keeps this list's own
// drag-to-allocate + rationale-edit affordances, which the Requirements
// screen doesn't need.
function ExpandableRow({
  requirement,
  architecture,
  status,
  expanded,
  dragging,
  onToggle,
  onDragStart,
  onDragEnd,
  onSaveRationale,
}: {
  requirement: Requirement
  architecture: Architecture
  status: 'not-started' | 'in-progress' | 'blocked' | 'complete'
  expanded: boolean
  dragging: boolean
  onToggle: () => void
  onDragStart: () => void
  onDragEnd: () => void
  onSaveRationale: (requirementId: string, rationale: string) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [draftRationale, setDraftRationale] = useState(requirement.allocationRationale ?? '')
  const [saving, setSaving] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const [maxHeight, setMaxHeight] = useState(0)

  useEffect(() => {
    setDraftRationale(requirement.allocationRationale ?? '')
    setEditing(false)
  }, [requirement.id, requirement.allocationRationale])

  useEffect(() => {
    if (!expanded) return
    const el = contentRef.current
    if (!el) return
    const observer = new ResizeObserver(() => setMaxHeight(el.scrollHeight))
    observer.observe(el)
    setMaxHeight(el.scrollHeight)
    return () => observer.disconnect()
  }, [expanded, editing])

  // Row shows the FIRST allocated element by default when the requirement
  // has more than one — this list is grouped per-element (see
  // groupedRequirements below), so a multi-allocated requirement's row
  // already appears once per group; the "Allocated to" field here still
  // only needs one representative element to display inline.
  const element =
    requirement.architectureElements.length > 0
      ? architecture.elements.find((e) => e.id === requirement.architectureElements[0])
      : null

  async function handleSave() {
    setSaving(true)
    try {
      await onSaveRationale(requirement.id, draftRationale.trim())
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <li className={`arch-req-row ${expanded ? 'expanded' : ''} ${dragging ? 'dragging' : ''}`}>
      <button
        type="button"
        className="arch-req-row-header"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('text/plain', JSON.stringify([requirement.id]))
          e.dataTransfer.effectAllowed = 'move'
          onDragStart()
        }}
        onDragEnd={onDragEnd}
        onClick={onToggle}
      >
        <span className="arch-req-row-status-dot" style={{ background: STATUS_COLOR[status] }} />
        <span className="arch-req-row-id">{requirement.id}</span>
        <span className="arch-req-row-text">{requirement.text}</span>
        {!element && <span className="arch-req-row-unallocated-badge">Unallocated</span>}
        <span className={`arch-req-row-chevron ${expanded ? 'open' : ''}`}>›</span>
      </button>

      <div
        className="arch-req-row-expand"
        style={{ maxHeight: expanded ? maxHeight : 0, opacity: expanded ? 1 : 0 }}
      >
        <div className="arch-req-row-expand-content" ref={contentRef}>
          <dl className="arch-req-row-fields">
            <dt>Allocated to</dt>
            <dd>{element ? `${element.id} — ${element.name}` : 'Unallocated'}</dd>
            <dt>Status</dt>
            <dd>{REQUIREMENT_STATUS_LABEL[requirement.status]}</dd>
          </dl>

          <div className="arch-req-row-rationale">
            <div className="arch-req-row-rationale-header">
              <span>Allocation rationale</span>
              {!editing && (
                <button type="button" className="requirement-detail-edit-btn" onClick={() => setEditing(true)}>
                  Edit
                </button>
              )}
            </div>
            {editing ? (
              <>
                <textarea
                  className="requirement-detail-edit-textarea"
                  value={draftRationale}
                  onChange={(e) => setDraftRationale(e.target.value)}
                  rows={3}
                  placeholder="e.g. goes in the Telemetry module, not Logging"
                />
                <div className="requirement-detail-edit-actions">
                  <button type="button" onClick={handleSave} disabled={saving}>
                    Save
                  </button>
                  <button
                    type="button"
                    className="requirement-detail-cancel-btn"
                    onClick={() => {
                      setDraftRationale(requirement.allocationRationale ?? '')
                      setEditing(false)
                    }}
                    disabled={saving}
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <p className="requirement-detail-note">{requirement.allocationRationale || 'None set.'}</p>
            )}
          </div>

          {!element && <p className="arch-req-row-hint">Drag this row onto a diagram element to allocate it.</p>}
        </div>
      </div>
    </li>
  )
}

export function ArchitectureRequirementList({
  requirements,
  architecture,
  statusByRequirementId,
  expandedRequirementId,
  onExpandedRequirementIdChange,
  draggingRequirementId,
  onDragStart,
  onDragEnd,
  onSaveRationale,
  activeElementId,
}: ArchitectureRequirementListProps) {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const groupRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  const elementNameById = useMemo(() => {
    const map = new Map<string, string>()
    for (const element of architecture.elements) {
      map.set(element.id, element.name)
    }
    return map
  }, [architecture])

  // A requirement with 0 elements groups under UNALLOCATED_GROUP; one with
  // 1+ elements appears once per element it's allocated to (duplicated rows
  // across groups) — same grouping rule as the main Requirements screen.
  const groupedRequirements = useMemo(() => {
    const groups = new Map<string, Requirement[]>()
    function addTo(groupName: string, r: Requirement) {
      const existing = groups.get(groupName)
      if (existing) existing.push(r)
      else groups.set(groupName, [r])
    }
    for (const r of requirements) {
      if (r.architectureElements.length === 0) {
        addTo(UNALLOCATED_GROUP, r)
      } else {
        for (const elementId of r.architectureElements) addTo(elementId, r)
      }
    }
    return Array.from(groups.entries()).sort(([a], [b]) => {
      if (a === UNALLOCATED_GROUP) return 1
      if (b === UNALLOCATED_GROUP) return -1
      return a.localeCompare(b)
    })
  }, [requirements])

  // Selecting an element on the diagram force-expands its group here and
  // scrolls it into view, so the left-hand list always reflects what's
  // focused in the diagram without the user having to hunt for it.
  useEffect(() => {
    if (!activeElementId) return
    setCollapsedGroups((prev) => {
      if (!prev.has(activeElementId)) return prev
      const next = new Set(prev)
      next.delete(activeElementId)
      return next
    })
    const el = groupRefs.current.get(activeElementId)
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [activeElementId])

  function toggleGroupCollapsed(groupName: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(groupName)) next.delete(groupName)
      else next.add(groupName)
      return next
    })
  }

  if (requirements.length === 0) {
    return <p className="arch-req-list-empty">No requirements yet.</p>
  }

  return (
    <div className="arch-req-groups">
      {groupedRequirements.map(([groupName, groupRequirements]) => {
        const isCollapsed = collapsedGroups.has(groupName)
        const isActive = activeElementId === groupName
        return (
          <div
            key={groupName}
            className={`requirements-group ${isActive ? 'arch-req-group-active' : ''}`}
            ref={(el) => {
              if (el) groupRefs.current.set(groupName, el)
              else groupRefs.current.delete(groupName)
            }}
          >
            <h2 className="requirements-group-heading">
              <button
                type="button"
                className="requirements-group-collapse-toggle"
                onClick={() => toggleGroupCollapsed(groupName)}
                aria-label={isCollapsed ? `Expand ${groupName}` : `Collapse ${groupName}`}
                aria-expanded={!isCollapsed}
              >
                {isCollapsed ? '▶' : '▼'}
              </button>
              {elementNameById.has(groupName) ? elementNameById.get(groupName) : groupName}
              <span className="requirements-group-count">{groupRequirements.length}</span>
            </h2>
            {!isCollapsed && (
              <ul className="arch-req-list">
                {groupRequirements.map((r) => (
                  <ExpandableRow
                    key={r.id}
                    requirement={r}
                    architecture={architecture}
                    status={statusByRequirementId.get(r.id) ?? 'not-started'}
                    expanded={expandedRequirementId === r.id}
                    dragging={draggingRequirementId === r.id}
                    onToggle={() => onExpandedRequirementIdChange(expandedRequirementId === r.id ? null : r.id)}
                    onDragStart={() => onDragStart(r.id)}
                    onDragEnd={onDragEnd}
                    onSaveRationale={onSaveRationale}
                  />
                ))}
              </ul>
            )}
          </div>
        )
      })}
    </div>
  )
}
