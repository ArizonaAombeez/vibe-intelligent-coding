import type { VicUser } from '../api/types'
import './UserBadge.css'

interface UserBadgeProps {
  user: VicUser
  onLogOut: () => void
}

export function UserBadge({ user, onLogOut }: UserBadgeProps) {
  return (
    <div className="user-badge">
      <span className="user-badge-name">
        {user.name}
        {user.isAdmin && <span className="user-badge-admin-tag">Admin</span>}
      </span>
      <button type="button" className="user-badge-logout" onClick={onLogOut}>
        Log out
      </button>
    </div>
  )
}
