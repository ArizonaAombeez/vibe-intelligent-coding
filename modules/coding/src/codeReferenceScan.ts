import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { SOURCE_TREE_DIRNAME } from './scaffold.js'

// Directories never worth descending into when scanning the generated
// source tree for a stray requirement-id mention — .git is the per-project
// source-tree repo gitInitIfNeeded creates (its internal objects can
// contain arbitrary binary blobs, not source text), the rest are the usual
// dependency-manager output no generated project code would itself define.
const SKIP_DIRNAMES = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '__pycache__'])

// Files worth reading as text when scanning for a requirement-id mention.
// Deliberately not "every file" — skips the marker JSON (structural
// metadata, not code, and never contains a REQ-NNN reference) and avoids
// wasting time on binary assets that could sit in a generated tree.
const SCAN_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.cs', '.rb', '.php', '.c', '.cpp', '.h', '.hpp',
  '.md', '.txt', '.json', '.yaml', '.yml',
])

async function collectFiles(dir: string, out: string[]): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return // directory doesn't exist yet (no Coding run has scaffolded/written anything) — nothing to scan
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRNAMES.has(entry.name)) continue
      await collectFiles(path.join(dir, entry.name), out)
    } else if (SCAN_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(path.join(dir, entry.name))
    }
  }
}

export interface CodeReference {
  // Path relative to the project's generated source tree root (src/), not
  // an absolute filesystem path — stable across machines/checkouts and
  // matches how CodingRun.allowedSubfolder already reports paths.
  relativePath: string
  // 1-indexed line numbers the id appears on, so the UI can show "3
  // mentions" without dumping full file contents into the reference report.
  lines: number[]
}

// Best-effort scan of the generated source tree for a literal "REQ-NNN"
// mention (the same convention requirementIdHighlight.tsx renders as a
// clickable id in the UI) — e.g. a Dev-written comment like "// REQ-042:
// lockout after 5 attempts". This is NOT a structural reference the way
// Story.requirementIds/TestCase.requirementIds are: nothing enforces that a
// comment stays in sync with the id it names, so a match here is reported
// to the human, never auto-rewritten — see elicitation.ts's
// findRequirementReferences for the structural-reference half of this same
// check.
export async function scanCodeForRequirementReferences(
  projectDir: string,
  requirementId: string,
): Promise<CodeReference[]> {
  const srcRoot = path.join(projectDir, SOURCE_TREE_DIRNAME)
  const files: string[] = []
  await collectFiles(srcRoot, files)

  const mentionPattern = new RegExp(`\\b${requirementId}\\b`)
  const references: CodeReference[] = []

  for (const filePath of files) {
    let content: string
    try {
      content = await readFile(filePath, 'utf-8')
    } catch {
      continue // unreadable (permissions, or a race with a concurrent write) — skip rather than fail the whole scan
    }
    const lines: number[] = []
    content.split('\n').forEach((line, i) => {
      if (mentionPattern.test(line)) lines.push(i + 1)
    })
    if (lines.length > 0) {
      references.push({ relativePath: path.relative(srcRoot, filePath).split(path.sep).join('/'), lines })
    }
  }

  return references
}
