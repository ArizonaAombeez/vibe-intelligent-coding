import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

// Local-machine credential storage for plugin settings, kept entirely
// separate from project files: never included in project export/PDF
// snapshots, never synced as project content, and gitignored by default.
// Keyed by plugin id -> field key -> value.
export type SecretsData = Record<string, Record<string, string>>

export class SecretsStore {
  private readonly file: string

  constructor(secretsDir: string) {
    this.file = path.join(secretsDir, 'secrets.json')
  }

  async readAll(): Promise<SecretsData> {
    try {
      const raw = await readFile(this.file, 'utf-8')
      return JSON.parse(raw) as SecretsData
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw err
    }
  }

  async getPluginValues(pluginId: string): Promise<Record<string, string>> {
    const all = await this.readAll()
    return all[pluginId] ?? {}
  }

  async setPluginValues(pluginId: string, values: Record<string, string>): Promise<void> {
    const all = await this.readAll()
    all[pluginId] = { ...all[pluginId], ...values }
    await mkdir(path.dirname(this.file), { recursive: true })
    await writeFile(this.file, JSON.stringify(all, null, 2), 'utf-8')
  }
}
