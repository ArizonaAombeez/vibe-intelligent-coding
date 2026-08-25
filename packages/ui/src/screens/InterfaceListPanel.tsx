import type { Architecture, ArchitectureElement, CheckInterfacesResult } from '../api/types'
import './RequirementDetailPanel.css'
import './InterfaceListPanel.css'

interface InterfaceListPanelProps {
  architecture: Architecture
  checkResult: CheckInterfacesResult | null
  onSelectDefinition: (definitionId: string) => void
  onSelectPair: (fromId: string, toId: string) => void
  onClose: () => void
}

interface DefinitionRow {
  id: string
  name: string
  participants: Array<{ elementId: string; role: string; element?: ArchitectureElement }>
  status: 'defined' | 'incomplete' | 'undefined' | 'stale' | 'misaligned'
  operationCount: number
  // Per-operation missing-field detail (Area B data-contract requirement),
  // only populated for 'incomplete' rows — this is what lets the row show
  // e.g. "getScore: missing range, unit" instead of just a bare "Incomplete"
  // label with nothing to act on.
  problems: string[]
}

interface UncoveredPairRow {
  fromId: string
  toId: string
  from?: ArchitectureElement
  to?: ArchitectureElement
}

// An element's own interface copy pointing at a masterDefinitionId with no
// real InterfaceDefinition behind it — see architecture.ts's
// danglingElementInterfaces comment for how this happens. No definition
// object and no real "other participant" to group/navigate to (the master
// is gone, not just out of date), so this renders as its own informational
// row rather than joining definitionRows or uncoveredPairs.
interface DanglingRow {
  elementId: string
  masterDefinitionId: string
  element?: ArchitectureElement
}

// Every connected element pair in the architecture — used only to find
// edges with no covering InterfaceDefinition yet (an "undefined" row below
// has no definition object to group by, so it's rendered as a raw pair).
function connectedPairs(elements: ArchitectureElement[]): Array<{ fromId: string; toId: string }> {
  const seen = new Set<string>()
  const pairs: Array<{ fromId: string; toId: string }> = []
  for (const element of elements) {
    for (const toId of element.interfaces) {
      const key = [element.id, toId].sort().join('|')
      if (seen.has(key)) continue
      seen.add(key)
      pairs.push({ fromId: element.id, toId })
    }
  }
  return pairs
}

const STATUS_ORDER: Record<DefinitionRow['status'], number> = { undefined: 0, misaligned: 1, incomplete: 2, stale: 3, defined: 4 }
const STATUS_LABEL: Record<DefinitionRow['status'], string> = {
  undefined: 'Undefined',
  misaligned: 'Needs review',
  incomplete: 'Missing I/O detail',
  stale: 'Stale',
  defined: 'Defined',
}
// Only 'defined' isn't a problem — every other status means something on
// this definition is unpopulated, out of date, or not yet reconciled by a
// participant, so the row (and its status label) render in red.
const IS_PROBLEM: Record<DefinitionRow['status'], boolean> = {
  undefined: true,
  misaligned: true,
  incomplete: true,
  stale: true,
  defined: false,
}

// Groups one row per InterfaceDefinition (participant chips instead of two
// labels) — the "list ... all the interfaces" half of the manual-interface
// requirement, now covering N-ary shared interfaces (e.g. a bus with 3+
// participants) as a single row rather than one row per pairwise edge.
export function InterfaceListPanel({ architecture, checkResult, onSelectDefinition, onSelectPair, onClose }: InterfaceListPanelProps) {
  const definitions = architecture.interfaceDefinitions ?? []
  const elementById = new Map(architecture.elements.map((e) => [e.id, e]))

  const staleIds = new Set((checkResult?.staleContracts ?? []).map((d) => d.id))
  const misalignedByDefinition = new Map<string, string[]>()
  for (const m of checkResult?.misalignedElements ?? []) {
    misalignedByDefinition.set(m.masterDefinitionId, [...(misalignedByDefinition.get(m.masterDefinitionId) ?? []), m.elementId])
  }
  const incompleteByPairKey = new Map<string, string[]>()
  for (const op of checkResult?.incompleteOperations ?? []) {
    const key = [op.fromId, op.toId].sort().join('|')
    const label = `${op.operationName}: missing ${op.missingFields.join(', ')}`
    incompleteByPairKey.set(key, [...(incompleteByPairKey.get(key) ?? []), label])
  }

  const definitionRows: DefinitionRow[] = definitions
    .map((definition) => {
      const participants = definition.participants.map((p) => ({ ...p, element: elementById.get(p.elementId) }))
      const misalignedElementIds = misalignedByDefinition.get(definition.id) ?? []
      // Incomplete-operations detail is reported per pair by checkInterfaces
      // — pull it in for any pair this definition's participants form.
      const incompleteProblems = new Set<string>()
      for (let i = 0; i < participants.length; i++) {
        for (let j = i + 1; j < participants.length; j++) {
          const key = [participants[i].elementId, participants[j].elementId].sort().join('|')
          for (const label of incompleteByPairKey.get(key) ?? []) incompleteProblems.add(label)
        }
      }
      const status: DefinitionRow['status'] =
        definition.status !== 'defined' || definition.operations.length === 0
          ? 'undefined'
          : misalignedElementIds.length > 0
            ? 'misaligned'
            : staleIds.has(definition.id)
              ? 'stale'
              : incompleteProblems.size > 0
                ? 'incomplete'
                : 'defined'
      const problems =
        status === 'undefined'
          ? ['No contract defined']
          : status === 'misaligned'
            ? [`Needs review by: ${misalignedElementIds.map((id) => elementById.get(id)?.name ?? id).join(', ')} — the master interface changed since their own copy was last reconciled`]
            : status === 'stale'
              ? ['Contract is stale — an endpoint changed since it was last defined']
              : Array.from(incompleteProblems)
      return {
        id: definition.id,
        name: definition.name,
        participants,
        status,
        operationCount: definition.operations.length,
        problems,
      }
    })
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status])

  // Uncovered edges: a connection exists (element.interfaces) but no
  // InterfaceDefinition covers both ends yet — surfaced separately since
  // there's no definition object to group these under.
  const coveredPairKeys = new Set(
    definitions.flatMap((d) =>
      d.participants.flatMap((p, i) => d.participants.slice(i + 1).map((q) => [p.elementId, q.elementId].sort().join('|'))),
    ),
  )
  const uncoveredPairs: UncoveredPairRow[] = connectedPairs(architecture.elements)
    .filter((pair) => !coveredPairKeys.has([pair.fromId, pair.toId].sort().join('|')))
    .map((pair) => ({ ...pair, from: elementById.get(pair.fromId), to: elementById.get(pair.toId) }))

  const danglingRows: DanglingRow[] = (checkResult?.danglingElementInterfaces ?? []).map((d) => ({
    ...d,
    element: elementById.get(d.elementId),
  }))

  const totalRows = definitionRows.length + uncoveredPairs.length + danglingRows.length

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel interface-list-panel" onClick={(e) => e.stopPropagation()}>
        <div className="requirement-detail-header">
          <span className="requirement-detail-id">Interfaces ({totalRows})</span>
          <button type="button" className="requirement-detail-edit-btn" onClick={onClose}>
            Close
          </button>
        </div>

        {totalRows === 0 ? (
          <p className="requirements-check-empty">No connected interfaces yet — connect two elements first.</p>
        ) : (
          <ul className="interface-list-panel-rows">
            {danglingRows.map((row) => (
              <li key={`dangling-${row.elementId}-${row.masterDefinitionId}`}>
                <div className="interface-list-panel-row interface-list-panel-row-problem">
                  <div className="interface-list-panel-row-main">
                    <span>{row.element?.name ?? row.elementId}</span>
                    <span className="interface-list-panel-status interface-list-panel-status-undefined">
                      Broken reference
                    </span>
                  </div>
                  <ul className="interface-list-panel-problems">
                    <li>
                      This element's own interface copy points at a deleted or corrupted definition
                      ({row.masterDefinitionId}) — re-define its connection to the other element below, or remove
                      the connection if it's no longer needed.
                    </li>
                  </ul>
                </div>
              </li>
            ))}
            {uncoveredPairs.map((row) => (
              <li key={`${row.fromId}-${row.toId}`}>
                <button
                  type="button"
                  className="interface-list-panel-row interface-list-panel-row-problem"
                  onClick={() => onSelectPair(row.fromId, row.toId)}
                >
                  <div className="interface-list-panel-row-main">
                    <span>
                      {row.from?.name ?? row.fromId} ↔ {row.to?.name ?? row.toId}
                    </span>
                    <span className="interface-list-panel-status interface-list-panel-status-undefined">
                      {STATUS_LABEL.undefined}
                    </span>
                  </div>
                  <ul className="interface-list-panel-problems">
                    <li>No contract defined</li>
                  </ul>
                </button>
              </li>
            ))}
            {definitionRows.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  className={`interface-list-panel-row${IS_PROBLEM[row.status] ? ' interface-list-panel-row-problem' : ''}`}
                  onClick={() => onSelectDefinition(row.id)}
                >
                  <div className="interface-list-panel-row-main">
                    <span>
                      {row.name} —{' '}
                      {row.participants.map((p) => `${p.element?.name ?? p.elementId} (${p.role})`).join(', ')}
                    </span>
                    <span className={`interface-list-panel-status interface-list-panel-status-${row.status}`}>
                      {STATUS_LABEL[row.status]}
                      {row.status !== 'undefined' && row.operationCount > 0 ? ` (${row.operationCount})` : ''}
                    </span>
                  </div>
                  {IS_PROBLEM[row.status] && (
                    <ul className="interface-list-panel-problems">
                      {row.problems.map((problem, i) => (
                        <li key={i}>{problem}</li>
                      ))}
                    </ul>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
