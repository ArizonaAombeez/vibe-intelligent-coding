import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

// The team's shared login list — kept on the projects root (the shared
// drive), not SECRETS_DIR, so every machine pointed at the same drive sees
// the same users. Deliberately minimal: no passwords, no sessions (see
// index.ts's X-VIC-User header) — this is identity/attribution only, not a
// security boundary, matching the "login exists but no logout/session-
// expiry" gap already flagged as acceptable in VIC - requirements.md.
export interface VicUser {
  id: string
  name: string
  createdAt: string
  // Gates the Settings > Plugins (LLM API keys) and Settings > Personas
  // tabs in the UI — everyone else gets the same pipeline access, just not
  // those two config screens. Client-side gate only, same trust model as
  // the rest of login: derived from the name, not a settable flag, since
  // there's no authentication to guard a "grant admin" action with.
  isAdmin: boolean
}

// Case-insensitive: matches how createUser already treats names as
// case-insensitively unique, so "mark"/"Mark"/"MARK" is always one person
// and always admin.
const ADMIN_NAMES = new Set(['mark'])

function isAdminName(name: string): boolean {
  return ADMIN_NAMES.has(name.trim().toLowerCase())
}

export type UsersData = { users: VicUser[] }

export class UsersStore {
  private readonly file: string

  constructor(projectsRoot: string) {
    this.file = path.join(projectsRoot, 'users.json')
  }

  // isAdmin is recomputed from the name on every read (not trusted from
  // disk) so it can never go stale relative to ADMIN_NAMES above — e.g. a
  // users.json written before isAdmin existed, or before a name was added
  // to/removed from the admin list, always reflects the current rule.
  async readAll(): Promise<UsersData> {
    let data: UsersData
    try {
      const raw = await readFile(this.file, 'utf-8')
      data = JSON.parse(raw) as UsersData
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        data = { users: [] }
      } else {
        throw err
      }
    }
    return { users: data.users.map((u) => ({ ...u, isAdmin: isAdminName(u.name) })) }
  }

  async listUsers(): Promise<VicUser[]> {
    const all = await this.readAll()
    return all.users
  }

  // Rejects a duplicate name (case-insensitive) rather than silently
  // creating a second entry — usernames are how people pick themselves out
  // of a shared list, so two "Mark"s would be ambiguous everywhere the name
  // is displayed.
  async createUser(name: string): Promise<VicUser> {
    const all = await this.readAll()
    const trimmed = name.trim()
    const existing = all.users.find((u) => u.name.toLowerCase() === trimmed.toLowerCase())
    if (existing) return existing

    const user: VicUser = {
      id: randomUUID(),
      name: trimmed,
      createdAt: new Date().toISOString(),
      isAdmin: isAdminName(trimmed),
    }
    all.users.push(user)
    await mkdir(path.dirname(this.file), { recursive: true })
    await writeFile(this.file, JSON.stringify(all, null, 2), 'utf-8')
    return user
  }
}
