import { useCallback, useEffect, useState } from 'react'
import type { VicCoreApi, VicUser } from '../api/types'
import './LoginScreen.css'

interface LoginScreenProps {
  api: VicCoreApi
  onLogIn: (user: VicUser) => void
}

export function LoginScreen({ api, onLogIn }: LoginScreenProps) {
  const [users, setUsers] = useState<VicUser[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const loadUsers = useCallback(() => {
    setLoadError(null)
    api
      .listUsers()
      .then(setUsers)
      .catch((err: unknown) => setLoadError((err as Error).message || 'Could not reach the server'))
  }, [api])

  useEffect(() => {
    loadUsers()
  }, [loadUsers])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    const name = newName.trim()
    if (!name || submitting) return
    setSubmitting(true)
    try {
      const user = await api.createUser(name)
      onLogIn(user)
    } catch (err) {
      setLoadError((err as Error).message || 'Could not create user')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="login-screen">
      <div className="login-content">
        <h1>VIC</h1>
        <p className="login-tagline">Who's working today?</p>

        {loadError ? (
          <div className="login-offline">
            <p className="login-offline-message">VIC server is offline: {loadError}</p>
            <button type="button" onClick={loadUsers}>
              Retry
            </button>
          </div>
        ) : (
          <>
            {users.length > 0 && (
              <ul className="login-user-list">
                {users.map((user) => (
                  <li key={user.id}>
                    <button type="button" className="login-user-button" onClick={() => onLogIn(user)}>
                      {user.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <form className="login-new-user" onSubmit={handleCreate}>
              <input
                type="text"
                placeholder="Enter your name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
              <button type="submit" disabled={!newName.trim() || submitting}>
                {submitting ? 'Adding…' : 'Continue'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  )
}
