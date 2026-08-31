import { useEffect, useState } from 'react'
import type { Architecture, ArchitectureConflict, ArchitectureElement, ArchitectureElementKind, Requirement, Status } from '../api/types'
import { STATUS_COLOR } from '../statusColor'
import './ArchitectureElementFocusView.css'

interface ArchitectureElementFocusViewProps {
  element: ArchitectureElement
  architecture: Architecture
  statusByElementId: Map<string, Status>
  allocatedRequirements: Requirement[]
  conflicts: ArchitectureConflict[]
  onBack: () => void
  onSelectInterface: (targetId: string) => void
  onSelectRequirement: (requirementId: string) => void
  onSave: (elementId: string, fields: { name: string; responsibility: string; interfaces: string[] }) => Promise<void>
  onDelete: (elementId: string) => void
  onToggleDynamicDesign: (elementId: string, enabled: boolean) => void
  onRemoveInterface: (fromId: string, toId: string) => void
  onCheckInterfaceConflict: (fromId: string, toId: string) => void
  onAskArchitectAboutInterface: (fromId: string, toId: string) => void
  onDefineInterface: (fromId: string, toId: string) => void
  onEditInterface: (fromId: string, toId: string) => void
}

const KIND_LABEL: Record<ArchitectureElementKind, string> = {
  functional: 'Functional block',
  'interface-spine': 'Interface spine',
  service: 'Service',
  external: 'External / environment',
  runtime: 'Runtime / execution',
  harness: 'Harness (composition root)',
}

// Which edge of the focused card a connected interface renders on: elements
// in an earlier column read as upstream (left), a later row as downstream
// (bottom), everything else — same row, later/equal column, or no grid
// position relationship worth distinguishing — falls to the right.
function edgeFor(element: ArchitectureElement, other: ArchitectureElement): 'left' | 'bottom' | 'right' {
  if (other.col < element.col) return 'left'
  if (other.row > element.row) return 'bottom'
  return 'right'
}

export function ArchitectureElementFocusView({
  element,
  architecture,
  statusByElementId,
  allocatedRequirements,
  conflicts,
  onBack,
  onSelectInterface,
  onSelectRequirement,
  onSave,
  onDelete,
  onToggleDynamicDesign,
  onRemoveInterface,
  onCheckInterfaceConflict,
  onAskArchitectAboutInterface,
  onDefineInterface,
  onEditInterface,
}: ArchitectureElementFocusViewProps) {
  const [editing, setEditing] = useState(false)
  const [draftName, setDraftName] = useState(element.name)
  const [draftResponsibility, setDraftResponsibility] = useState(element.responsibility)
  const [draftInterfaces, setDraftInterfaces] = useState<string[]>(element.interfaces)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setDraftName(element.name)
    setDraftResponsibility(element.responsibility)
    setDraftInterfaces(element.interfaces)
    setEditing(false)
  }, [element.id, element.name, element.responsibility, element.interfaces])

  async function handleSave() {
    if (!draftName.trim()) return
    setSaving(true)
    try {
      await onSave(element.id, {
        name: draftName.trim(),
        responsibility: draftResponsibility.trim(),
        interfaces: draftInterfaces,
      })
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  function toggleInterface(id: string) {
    setDraftInterfaces((prev) => (prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]))
  }

  const connected = element.interfaces
    .map((id) => architecture.elements.find((e) => e.id === id))
    .filter((e): e is ArchitectureElement => !!e)

  const left = connected.filter((e) => edgeFor(element, e) === 'left')
  const bottom = connected.filter((e) => edgeFor(element, e) === 'bottom')
  const right = connected.filter((e) => edgeFor(element, e) === 'right')
  const otherElements = architecture.elements.filter((e) => e.id !== element.id)

  return (
    <div className="architecture-focus-view">
      <div className="architecture-focus-header">
        <button type="button" className="architecture-focus-back-btn" onClick={onBack}>
          ← Back to architecture
        </button>
        <div className="architecture-focus-title">
          <span
            className="architecture-status-dot"
            style={{ background: STATUS_COLOR[statusByElementId.get(element.id) ?? 'not-started'] }}
          />
          <h2>{element.name}</h2>
          <span className="architecture-focus-kind">{element.kind}</span>
        </div>
        {element.responsibility && <p className="architecture-focus-description">{element.responsibility}</p>}
      </div>

      <div className="architecture-focus-stage">
        <div className="architecture-focus-edge architecture-focus-edge-left">
          {left.map((target) => (
            <button
              key={target.id}
              type="button"
              className="architecture-focus-interface-chip"
              onClick={() => onSelectInterface(target.id)}
              title={`${target.id} — ${target.name}`}
            >
              {target.name}
            </button>
          ))}
        </div>

        <div className="architecture-focus-center-col">
          <div className="architecture-focus-element-card">
            <span className="architecture-focus-element-id">{element.id}</span>
            <strong>{element.name}</strong>
          </div>

          <div className="architecture-focus-requirements">
            <h3>Allocated requirements</h3>
            {allocatedRequirements.length === 0 ? (
              <p className="requirement-detail-note">None allocated yet.</p>
            ) : (
              <ul className="architecture-focus-requirement-list">
                {allocatedRequirements.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      className="architecture-focus-requirement-chip"
                      onClick={() => onSelectRequirement(r.id)}
                      title={r.text}
                    >
                      <strong>{r.id}</strong> — {r.text}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="architecture-focus-edge architecture-focus-edge-right">
          {right.map((target) => (
            <button
              key={target.id}
              type="button"
              className="architecture-focus-interface-chip"
              onClick={() => onSelectInterface(target.id)}
              title={`${target.id} — ${target.name}`}
            >
              {target.name}
            </button>
          ))}
        </div>
      </div>

      <div className="architecture-focus-edge architecture-focus-edge-bottom">
        {bottom.map((target) => (
          <button
            key={target.id}
            type="button"
            className="architecture-focus-interface-chip"
            onClick={() => onSelectInterface(target.id)}
            title={`${target.id} — ${target.name}`}
          >
            {target.name}
          </button>
        ))}
      </div>

      {/* Metadata zone underneath the focused element — grows/shrinks as its
          own sections are opened (edit mode, conflicts) rather than the
          focus view jumping in height all at once. */}
      <div className="architecture-focus-metadata">
        <div className="architecture-focus-metadata-header">
          <h3>{KIND_LABEL[element.kind]}</h3>
          <div className="architecture-focus-metadata-actions">
            {!editing && (
              <button type="button" className="requirement-detail-edit-btn" onClick={() => setEditing(true)}>
                Edit
              </button>
            )}
            <button
              type="button"
              className="requirement-detail-edit-btn"
              onClick={() => {
                if (window.confirm(`Delete "${element.name}"? This cannot be undone.`)) onDelete(element.id)
              }}
            >
              Delete
            </button>
          </div>
        </div>

        <div className={`architecture-focus-metadata-expand ${editing ? 'open' : ''}`}>
          <div className="architecture-focus-metadata-expand-content">
            <label className="architecture-detail-field-label">Name</label>
            <input
              className="architecture-detail-input"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
            />
            <label className="architecture-detail-field-label">Responsibility</label>
            <textarea
              className="requirement-detail-edit-textarea"
              value={draftResponsibility}
              onChange={(e) => setDraftResponsibility(e.target.value)}
              rows={3}
            />
            <label className="architecture-detail-field-label">Interfaces exposed/consumed</label>
            <div className="architecture-detail-interface-list">
              {otherElements.length === 0 && <p className="requirement-detail-note">No other elements yet.</p>}
              {otherElements.map((other) => (
                <label key={other.id} className="architecture-detail-interface-option">
                  <input
                    type="checkbox"
                    checked={draftInterfaces.includes(other.id)}
                    onChange={() => toggleInterface(other.id)}
                  />
                  {other.id} — {other.name}
                </label>
              ))}
            </div>
            <div className="requirement-detail-edit-actions">
              <button type="button" onClick={handleSave} disabled={saving || !draftName.trim()}>
                Save
              </button>
              <button
                type="button"
                className="requirement-detail-cancel-btn"
                onClick={() => {
                  setDraftName(element.name)
                  setDraftResponsibility(element.responsibility)
                  setDraftInterfaces(element.interfaces)
                  setEditing(false)
                }}
                disabled={saving}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>

        <section className="architecture-focus-metadata-section">
          <h3>Interfaces</h3>
          {element.interfaces.length === 0 ? (
            <p className="requirement-detail-note">None.</p>
          ) : (
            <ul className="architecture-interface-list">
              {element.interfaces.map((id) => {
                const target = architecture.elements.find((e) => e.id === id)
                const contract = (architecture.interfaceDefinitions ?? []).find(
                  (d) => d.participants.some((p) => p.elementId === element.id) && d.participants.some((p) => p.elementId === id),
                )
                const isDefined = contract?.status === 'defined' && contract.operations.length > 0
                const contractLabel = isDefined ? `Defined (${contract.operations.length})` : contract?.status === 'stale' ? 'Stale' : 'Not defined'
                return (
                  <li key={id} className="architecture-interface-row">
                    <span>
                      {target ? `${target.id} — ${target.name}` : id}
                      <span
                        className="architecture-focus-kind"
                        style={{ marginLeft: '0.5em', color: isDefined ? undefined : 'var(--status-red)', fontWeight: isDefined ? undefined : 600 }}
                      >
                        {contractLabel}
                      </span>
                    </span>
                    {isDefined && (
                      <ul className="architecture-interface-operation-list">
                        {contract.operations.map((op) => {
                          const ioDetail = [
                            op.range && `range: ${op.range}`,
                            op.resolution && `resolution: ${op.resolution}`,
                            op.unit && `unit: ${op.unit}`,
                            op.drivenDirectly ? 'driven directly' : op.updateFrequency && `min update: ${op.updateFrequency}`,
                          ].filter(Boolean)
                          const missing = ioDetail.length === 0
                          return (
                            <li key={op.name} className="requirement-detail-note" style={missing ? { color: 'var(--status-red)' } : undefined}>
                              <strong>{op.name}</strong>
                              {missing ? ' — I/O detail not defined' : ` — ${ioDetail.join(', ')}`}
                            </li>
                          )
                        })}
                      </ul>
                    )}
                    <div className="architecture-interface-actions">
                      <button
                        type="button"
                        className="requirement-detail-edit-btn"
                        onClick={() => onDefineInterface(element.id, id)}
                        title={
                          contractLabel === 'Not defined'
                            ? 'Define this interface'
                            : 'Redefine this interface (overwrites the existing contract, e.g. to fill in newly-added I/O detail fields)'
                        }
                      >
                        {contractLabel === 'Not defined' ? 'Define' : 'Redefine'}
                      </button>
                      <button
                        type="button"
                        className="requirement-detail-edit-btn"
                        onClick={() => onEditInterface(element.id, id)}
                        title="Manually edit this interface's operations (no LLM call)"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="requirement-detail-edit-btn"
                        onClick={() => onCheckInterfaceConflict(element.id, id)}
                      >
                        Check
                      </button>
                      <button
                        type="button"
                        className="requirement-detail-edit-btn"
                        onClick={() => onAskArchitectAboutInterface(element.id, id)}
                      >
                        Ask architect
                      </button>
                      <button
                        type="button"
                        className="requirement-detail-edit-btn"
                        onClick={() => onRemoveInterface(element.id, id)}
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section className="architecture-focus-metadata-section">
          <h3>Dynamic design</h3>
          <label className="architecture-detail-interface-option">
            <input
              type="checkbox"
              checked={element.dynamicDesignEnabled ?? false}
              onChange={(e) => onToggleDynamicDesign(element.id, e.target.checked)}
            />
            Generate a dynamic (sequence/flow) view for this element
          </label>
        </section>

        {conflicts.length > 0 && (
          <section className="architecture-focus-metadata-section">
            <h3>Conflicts</h3>
            <ul className="quality-score-deductions">
              {conflicts.map((c) => (
                <li key={c.id} className="quality-score-conflict-value">
                  <strong>{c.kind}</strong> — {c.rationale}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  )
}
