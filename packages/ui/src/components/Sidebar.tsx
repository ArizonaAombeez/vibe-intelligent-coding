import type { SubstepInfo } from '../api/types'
import { STATUS_COLOR, STATUS_LABEL } from '../statusColor'
import './Sidebar.css'

interface SidebarProps {
  substeps: SubstepInfo[]
  activeSubstep: string | null
  onSelectSubstep: (id: string) => void
  collapsed: boolean
}

export function Sidebar({ substeps, activeSubstep, onSelectSubstep, collapsed }: SidebarProps) {
  if (substeps.length === 0) {
    return null
  }

  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
      {substeps.map((substep) => (
        <button
          key={substep.id}
          type="button"
          className={`sidebar-item ${activeSubstep === substep.id ? 'active' : ''}`}
          onClick={() => onSelectSubstep(substep.id)}
          title={collapsed ? `${substep.label} — ${STATUS_LABEL[substep.status]}` : undefined}
        >
          <span
            className="sidebar-item-dot"
            style={{ background: STATUS_COLOR[substep.status] }}
          />
          {!collapsed && <span className="sidebar-item-label">{substep.label}</span>}
        </button>
      ))}
    </aside>
  )
}
