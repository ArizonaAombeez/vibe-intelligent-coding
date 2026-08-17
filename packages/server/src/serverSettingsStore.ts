import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

// Local-machine operator settings that aren't secrets and aren't
// per-persona, kept in their own file alongside secrets.json /
// persona-settings.json rather than folded into either — this stays a
// small flat map so future operator-only settings (not synced, not
// remote-facing) have a natural home without overloading those two files'
// existing shapes.
export type ServerSettingsData = {
  projectsRootOverride?: string
}

export class ServerSettingsStore {
  private readonly file: string

  constructor(secretsDir: string) {
    this.file = path.join(secretsDir, 'server-settings.json')
  }

  async readAll(): Promise<ServerSettingsData> {
    try {
      const raw = await readFile(this.file, 'utf-8')
      return JSON.parse(raw) as ServerSettingsData
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw err
    }
  }

  async getProjectsRootOverride(): Promise<string | undefined> {
    const all = await this.readAll()
    return all.projectsRootOverride
  }

  async setProjectsRootOverride(projectsRootOverride: string | undefined): Promise<void> {
    const all = await this.readAll()
    if (projectsRootOverride) {
      all.projectsRootOverride = projectsRootOverride
    } else {
      delete all.projectsRootOverride
    }
    await mkdir(path.dirname(this.file), { recursive: true })
    await writeFile(this.file, JSON.stringify(all, null, 2), 'utf-8')
  }
}
