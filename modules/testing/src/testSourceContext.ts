import path from 'node:path'
import { readdir, readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { elementSubfolderName } from 'vic-coding'
import type { Project, TestCase } from 'vic-requirements-elicitation'

// Pre-flight source gathering for test-file generation (the "0-1 reads
// instead of 5" fix). The single biggest driver of how long each
// "Generate Test Case Automation" takes is the agent doing 4-6 discovery
// tool calls (list dir, glob for tests, glob for sources, read two sibling
// tests, read the implementation) BEFORE it writes anything — each with a
// multi-second model-latency reasoning pass in front of it. Everything the
// agent actually needs is knowable from the project + disk cheaply, right
// here, with no LLM round-trip: which file(s) to import, what they export,
// and one example test to copy the harness style from. Injecting that into
// the prompt lets the agent go straight to `write` with at most one
// confirmatory `read`.

export interface TestFileContext {
  // Relative path (POSIX, relative to the test file's own directory) the
  // agent should import the code under test from.
  importPath: string
  // Absolute path on disk, for the prompt builder to read the file.
  absPath: string
  // Named exports parsed out of that file, best-effort.
  exportNames: string[]
  // The file's full text (capped), so the agent needn't read it at all.
  content: string
}

export interface TestSourceContext {
  // One per file the test needs to import (1 for a functional test, up to 2
  // for an integration test).
  targets: TestFileContext[]
  // A sibling *.test.* file's full text (capped) to copy the harness /
  // mock-setup style from, or undefined if this is the first test in scope.
  exampleTest?: { name: string; content: string }
}

const MAX_FILE_CHARS = 8_000
const TEST_FILE_SUFFIX = /\.test\.[^./\\]+$/
const SOURCE_EXT = /\.(m|c)?jsx?$|\.tsx?$|\.py$/

// export function foo / export class Foo / export const foo / export { a, b }
// export default is reported as "default".
function parseExportNames(src: string): string[] {
  const names = new Set<string>()
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1])
  for (const m of src.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1])
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const raw of m[1].split(',')) {
      const cleaned = raw.trim().split(/\s+as\s+/).pop()?.trim()
      if (cleaned) names.add(cleaned)
    }
  }
  if (/export\s+default\b/.test(src)) names.add('default')
  // Python
  for (const m of src.matchAll(/^(?:def|class)\s+([A-Za-z0-9_]+)/gm)) names.add(m[1])
  return [...names]
}

async function readCapped(absPath: string): Promise<string> {
  const text = await readFile(absPath, 'utf-8')
  return text.length > MAX_FILE_CHARS ? text.slice(0, MAX_FILE_CHARS) + '\n/* …truncated… */' : text
}

// Best-effort "the one obvious entry file" for an element's folder:
// prefer index.js/index.mjs/index.ts, then a file named like the folder,
// then the single non-test source file if there's exactly one, else the
// largest non-test source file.
async function findEntryFile(elementDir: string): Promise<string | undefined> {
  if (!existsSync(elementDir)) return undefined

  // The coding agent's observed convention nests a same-named subfolder
  // (e.g. game-engine/game-engine/) — descend into it if present.
  let dir = elementDir
  const base = path.basename(elementDir)
  const nested = path.join(elementDir, base)
  if (existsSync(nested) && (await stat(nested)).isDirectory()) dir = nested

  let entries: string[]
  try {
    entries = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name)
  } catch {
    return undefined
  }
  const sources = entries.filter((n) => SOURCE_EXT.test(n) && !TEST_FILE_SUFFIX.test(n))
  if (sources.length === 0) return undefined

  const preferred = ['index.js', 'index.mjs', 'index.ts', 'index.cjs']
  for (const p of preferred) if (sources.includes(p)) return path.join(dir, p)

  const folderNamed = sources.find((n) => n.replace(/\.[^.]+$/, '').toLowerCase() === base.toLowerCase())
  if (folderNamed) return path.join(dir, folderNamed)

  if (sources.length === 1) return path.join(dir, sources[0])

  // Largest by size — a rough "this is the main module" heuristic.
  let best: { name: string; size: number } | undefined
  for (const n of sources) {
    const s = await stat(path.join(dir, n))
    if (!best || s.size > best.size) best = { name: n, size: s.size }
  }
  return best ? path.join(dir, best.name) : undefined
}

async function findExampleTest(scopeDir: string): Promise<{ name: string; content: string } | undefined> {
  const found: string[] = []
  async function walk(d: string) {
    let entries
    try {
      entries = await readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue
        await walk(full)
      } else if (e.isFile() && TEST_FILE_SUFFIX.test(e.name)) {
        found.push(full)
      }
    }
  }
  await walk(scopeDir)
  if (found.length === 0) return undefined
  // Smallest existing test — least to copy, most likely a focused example.
  let best: { p: string; size: number } | undefined
  for (const p of found) {
    const s = await stat(p)
    if (!best || s.size < best.size) best = { p, size: s.size }
  }
  if (!best) return undefined
  return { name: path.basename(best.p), content: await readCapped(best.p) }
}

// scopeDir: absolute path of the test file's own directory
// (<srcRoot>/<allowedRelativePrefix>). For a functional test this IS the
// element folder; for an integration test it's _shared-interfaces/<pair>/.
export async function gatherTestSourceContext(
  project: Project,
  testCase: TestCase,
  srcRoot: string,
  allowedRelativePrefix: string,
): Promise<TestSourceContext> {
  const scopeDir = path.join(srcRoot, allowedRelativePrefix)
  const elements = project.architecture?.elements ?? []
  const targets: TestFileContext[] = []

  const elementIds: string[] =
    testCase.type === 'integration'
      ? testCase.interfaceElementIds ?? []
      : testCase.architectureElementId
        ? [testCase.architectureElementId]
        : []

  for (const id of elementIds) {
    const el = elements.find((e) => e.id === id)
    if (!el) continue
    const folder = elementSubfolderName(el)
    const elementDir = path.join(srcRoot, folder)
    const entryAbs = await findEntryFile(elementDir)
    if (!entryAbs) continue
    // Import path is relative to the test file's own directory.
    const rel = path.relative(scopeDir, entryAbs).split(path.sep).join('/')
    targets.push({
      importPath: rel.startsWith('.') ? rel : './' + rel,
      absPath: entryAbs,
      exportNames: parseExportNames(await readFile(entryAbs, 'utf-8').catch(() => '')),
      content: await readCapped(entryAbs).catch(() => ''),
    })
  }

  const exampleTest = await findExampleTest(scopeDir)
  return { targets, exampleTest }
}
