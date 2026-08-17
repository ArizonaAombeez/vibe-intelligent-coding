import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

// Requirement ids (REQ-NNN) are minted from a single counter shared across
// every project, not reset per project (mirrors SVN's one ever-increasing
// revision number) — chosen to minimise id collisions across project
// import/export. Kept in its own file rather than inside any one project's
// project.json, since it must survive independently of any single project.
interface GlobalSeqData {
  nextRequirementSeq: number
}

export class GlobalSeqStore {
  private readonly file: string

  constructor(homeDir: string) {
    this.file = path.join(homeDir, 'global-seq.json')
  }

  private async readAll(): Promise<GlobalSeqData> {
    try {
      const raw = await readFile(this.file, 'utf-8')
      return JSON.parse(raw) as GlobalSeqData
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { nextRequirementSeq: 1 }
      throw err
    }
  }

  // Returns the next requirement sequence number and persists the
  // incremented counter before returning, so ids are never reused even if
  // the caller never ends up saving the requirement it was minted for.
  async getAndIncrementRequirementSeq(): Promise<number> {
    return this.reserveRequirementSeqBlock(1)
  }

  // Reserves `count` contiguous sequence numbers in one go (e.g. for a
  // synchronous batch-import parse that needs its ids up front) and returns
  // the first one — the caller assigns seqStart, seqStart+1, ... itself.
  async reserveRequirementSeqBlock(count: number): Promise<number> {
    const data = await this.readAll()
    const seqStart = data.nextRequirementSeq
    await mkdir(path.dirname(this.file), { recursive: true })
    await writeFile(this.file, JSON.stringify({ nextRequirementSeq: seqStart + count }, null, 2), 'utf-8')
    return seqStart
  }
}
