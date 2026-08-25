import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Architecture, ArchitectureElement, InterfaceDefinition } from 'vic-requirements-elicitation'
import { connectedPairs } from 'vic-requirements-elicitation'
import { SHARED_INTERFACES_DIRNAME, SOURCE_TREE_DIRNAME, elementSubfolderName, sharedInterfaceSubfolderName } from './scaffold.js'

// Same skip-list/extension-list as codeReferenceScan.ts (kept duplicated
// rather than shared — the two scans have no other coupling and importing
// across them for two array literals isn't worth it).
const SKIP_DIRNAMES = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '__pycache__'])
const SCAN_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.cs', '.rb', '.php', '.c', '.cpp', '.h', '.hpp',
])

async function collectFiles(dir: string, out: string[]): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return // subfolder doesn't exist yet — no Coding run has scaffolded/written anything there
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

// Identifier-looking tokens a Dev agent's generated source is likely to
// name a function/method after — deliberately loose (this is a best-effort
// text scan across arbitrary languages, not a parser) so it also catches
// e.g. Python's def foo, Go's func Foo, a TS export const foo =.
const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/g

// Declaration-looking lines only — used for the reverse direction
// (code defines an operation the contract never mentioned). Deliberately
// narrower than IDENTIFIER: matching every bare identifier in a file would
// flag ordinary variables/imports as "undocumented interfaces" and drown
// any real signal. Covers the common function/method declaration shapes
// across the languages SCAN_EXTENSIONS allows (TS/JS, Python, Go, Java/
// Kotlin/C#, Rust, Ruby, PHP, C/C++) — best-effort, not a parser, so it
// will still miss unusual styles rather than false-positive on them.
const DECLARATION_LINE =
  /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_]\w*)|^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_]\w*)\s*=\s*(?:async\s*)?\(|^\s*def\s+([A-Za-z_]\w*)|^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)|^\s*(?:public|private|protected|internal|static|final|override|virtual)[\w\s<>[\],]*\s([A-Za-z_]\w*)\s*\(/gm

// A contract operation name (often written as prose, e.g. "Get user
// profile") reduced to the token an implementation would plausibly use as
// an identifier — lowercased, non-alphanumerics stripped, so "Get user
// profile" and "getUserProfile"/"get_user_profile" compare equal.
function normalizeToken(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

interface ScannedDir {
  // Every identifier-looking token anywhere in the folder's source files —
  // used to check a contract operation isn't missing from the code.
  allTokens: Set<string>
  // Normalized token -> the raw declared name it came from, restricted to
  // declaration-looking lines — used to check a declared operation isn't
  // missing from the contract.
  declaredTokens: Map<string, string>
}

async function scanDir(dir: string): Promise<ScannedDir> {
  const files: string[] = []
  await collectFiles(dir, files)
  const allTokens = new Set<string>()
  const declaredTokens = new Map<string, string>()
  for (const filePath of files) {
    let content: string
    try {
      content = await readFile(filePath, 'utf-8')
    } catch {
      continue // unreadable (permissions, or a race with a concurrent write) — skip rather than fail the whole scan
    }
    for (const match of content.matchAll(IDENTIFIER)) {
      allTokens.add(normalizeToken(match[0]))
    }
    for (const match of content.matchAll(DECLARATION_LINE)) {
      const name = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5]
      if (!name) continue
      declaredTokens.set(normalizeToken(name), name)
    }
  }
  return { allTokens, declaredTokens }
}

export interface UndocumentedOperation {
  fromId: string
  toId: string
  operationName: string
}

export interface UnimplementedOperation {
  fromId: string
  toId: string
  operationName: string
}

export interface CheckInterfaceCodeAlignmentResult {
  // Contract operations with no matching identifier found anywhere in
  // either endpoint's subfolder or the pair's shared-interface subfolder —
  // the Architecture defines it, but no code appears to implement it yet.
  unimplementedOperations: UnimplementedOperation[]
  // Identifier-looking tokens found in a pair's code that don't match any
  // operation on that pair's contract — code that may be implementing an
  // interface the Architecture never defined. Best-effort and noisy by
  // design (any local helper/variable name can false-positive here), so
  // this is reported for a human to judge, never auto-removed — matches
  // this project's rule that a discrepancy is surfaced, not deleted.
  undocumentedIdentifiers: UndocumentedOperation[]
  aligned: boolean
}

// "Check Interface/Code Alignment" — the code-vs-Architecture half of
// interface governance (Check Interfaces already covers the
// Architecture-only half: does every connected pair have a contract at
// all). Mechanical text scan, no LLM: for every connected pair with a
// *defined* contract, compares the contract's operation names against
// identifier tokens found in the generated source under that pair's own
// subfolders. Pairs with no contract yet are skipped here — that gap is
// checkInterfaces' job, not this one's.
export async function checkInterfaceCodeAlignment(
  projectDir: string,
  architecture: Architecture,
): Promise<CheckInterfaceCodeAlignmentResult> {
  const elementById = new Map<string, ArchitectureElement>(architecture.elements.map((e) => [e.id, e]))
  const definitions: InterfaceDefinition[] = architecture.interfaceDefinitions ?? []
  const srcRoot = path.join(projectDir, SOURCE_TREE_DIRNAME)

  const unimplementedOperations: UnimplementedOperation[] = []
  const undocumentedIdentifiers: UndocumentedOperation[] = []

  for (const pair of connectedPairs(architecture.elements)) {
    const contract = definitions.find(
      (d) => d.participants.some((p) => p.elementId === pair.fromId) && d.participants.some((p) => p.elementId === pair.toId),
    )
    if (!contract || contract.status !== 'defined' || contract.operations.length === 0) continue

    const from = elementById.get(pair.fromId)
    const to = elementById.get(pair.toId)
    if (!from || !to) continue

    const dirs = [
      path.join(srcRoot, elementSubfolderName(from)),
      path.join(srcRoot, elementSubfolderName(to)),
      path.join(srcRoot, SHARED_INTERFACES_DIRNAME, sharedInterfaceSubfolderName(pair.fromId, pair.toId)),
    ]
    const allTokens = new Set<string>()
    const declaredTokens = new Map<string, string>()
    for (const dir of dirs) {
      const scanned = await scanDir(dir)
      for (const token of scanned.allTokens) allTokens.add(token)
      for (const [token, name] of scanned.declaredTokens) declaredTokens.set(token, name)
    }

    const operationTokenSet = new Set<string>()
    for (const op of contract.operations) {
      const token = normalizeToken(op.name)
      if (!token) continue
      operationTokenSet.add(token)
      if (!allTokens.has(token)) {
        unimplementedOperations.push({ fromId: pair.fromId, toId: pair.toId, operationName: op.name })
      }
    }

    // Only checked once code has actually been scaffolded/written for this
    // pair — an empty declaredTokens (no Coding run yet) would otherwise
    // report nothing either way, correctly, since the loop below is a no-op.
    for (const [token, declaredName] of declaredTokens) {
      if (!operationTokenSet.has(token)) {
        undocumentedIdentifiers.push({ fromId: pair.fromId, toId: pair.toId, operationName: declaredName })
      }
    }
  }

  return {
    unimplementedOperations,
    undocumentedIdentifiers,
    aligned: unimplementedOperations.length === 0 && undocumentedIdentifiers.length === 0,
  }
}
