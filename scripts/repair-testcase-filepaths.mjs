// Report-only diagnostic for a project's test-case filePath pointers.
//
// This is the read-only sibling of the in-app heal. As of T1.3,
// reconcileTestCaseFilesForProject (wired into every coding run, delete, and
// test-file generation) already clears a filePath that is missing OR is not
// a runnable "*.test.<ext>" name, resetting the test case to "not generated"
// so it can be regenerated. So there is exactly one code path that mutates
// project data — this script does NOT write anything, it only tells you what
// that heal will do (or has already done) and surfaces adjacent problems the
// heal doesn't touch (orphan files, broken imports).
//
// Usage:
//   node scripts/repair-testcase-filepaths.mjs --project-dir "Q:/VIC_Data/<project>"
//   node scripts/repair-testcase-filepaths.mjs            (defaults to $VIC_PROJECT_DIR)

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const argDir = (() => {
  const i = process.argv.indexOf('--project-dir')
  return i !== -1 ? process.argv[i + 1] : undefined
})()
const PROJECT_DIR = argDir ?? process.env.VIC_PROJECT_DIR
if (!PROJECT_DIR) {
  console.error('Pass --project-dir <path> (or set VIC_PROJECT_DIR).')
  process.exit(1)
}
const PROJECT_JSON = path.join(PROJECT_DIR, 'project.json')
const SRC_ROOT = path.join(PROJECT_DIR, 'src')

// Same single rule the app uses — keep in sync with
// modules/coding/src/testFilePattern.ts.
const TEST_FILE_SUFFIX = /\.test\.[^./\\]+$/
const isTestFileName = (p) => TEST_FILE_SUFFIX.test((p.split('\\').join('/').split('/').pop() ?? ''))

function listTestFiles(dir, acc = []) {
  if (!existsSync(dir)) return acc
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      listTestFiles(full, acc)
    } else if (entry.isFile() && isTestFileName(entry.name)) {
      acc.push(full)
    }
  }
  return acc
}
const rel = (p) => path.relative(SRC_ROOT, p).split(path.sep).join('/')

if (!existsSync(PROJECT_JSON)) {
  console.error(`project.json not found at ${PROJECT_JSON}`)
  process.exit(1)
}
const project = JSON.parse(readFileSync(PROJECT_JSON, 'utf8'))
const tests = (project.testSuite?.tests ?? []).filter((t) => !t.deletedAt)

const notATestFile = []
const fileMissing = []
const valid = []
const neverGenerated = []

for (const t of tests) {
  if (!t.filePath) {
    neverGenerated.push(t)
    continue
  }
  if (!isTestFileName(t.filePath)) {
    notATestFile.push(t)
    continue
  }
  const abs = path.resolve(SRC_ROOT, t.filePath)
  if (existsSync(abs) && statSync(abs).isFile()) valid.push(t)
  else fileMissing.push(t)
}

const onDisk = listTestFiles(SRC_ROOT)
const claimed = new Set(valid.map((t) => t.filePath.split(path.sep).join('/')))
const orphans = [...new Set(onDisk.map(rel))].filter((p) => !claimed.has(p))

console.log('='.repeat(72))
console.log('Test-case filePath report  (READ ONLY — no changes written)')
console.log('='.repeat(72))
console.log(`project.json : ${PROJECT_JSON}`)
console.log(`src/         : ${SRC_ROOT}`)
console.log(`active test cases           : ${tests.length}`)
console.log(`  filePath valid            : ${valid.length}`)
console.log(`  filePath NOT a test file  : ${notATestFile.length}   <- app heal clears these (T1.3)`)
console.log(`  filePath file missing     : ${fileMissing.length}   <- app heal clears these`)
console.log(`  never generated           : ${neverGenerated.length}   <- run "Generate All Automations"`)
console.log(`test files on disk          : ${onDisk.length}`)
console.log(`  orphaned (no owning case) : ${orphans.length}   (these run as SW outcomes, not requirement-traced)`)
console.log()

if (notATestFile.length) {
  console.log('--- filePath points at something that is NOT a "*.test.<ext>" file ---')
  console.log('    (the app heal resets these to "not generated" on the next coding run')
  console.log('     or test-file generation; then "Generate All Automations" picks them up)')
  for (const t of notATestFile) console.log(`  ${t.id}  [${t.type}]  -> ${t.filePath}`)
  console.log()
}
if (fileMissing.length) {
  console.log('--- filePath is a valid test-file name but the file is gone from disk ---')
  for (const t of fileMissing) console.log(`  ${t.id}  [${t.type}]  was: ${t.filePath}`)
  console.log()
}
if (neverGenerated.length) {
  console.log('--- test cases that never had an automation generated ---')
  for (const t of neverGenerated) {
    const reqs = (t.requirementIds ?? []).join(', ') || '(none)'
    console.log(`  ${t.id}  [${t.type}]  reqs=${reqs}  "${(t.title ?? '').slice(0, 60)}"`)
  }
  console.log()
}

// Broken relative imports in the on-disk test files (a mechanical "this test
// is out of sync with the code" signal the filePath heal does not catch).
const IMPORT_RE = /(?:require\(|from\s+)['"](\.\.?\/[^'"]+\.(?:js|mjs|cjs))['"]/g
const brokenImports = []
for (const abs of onDisk) {
  const body = readFileSync(abs, 'utf8')
  for (const m of body.matchAll(IMPORT_RE)) {
    const target = path.resolve(path.dirname(abs), m[1])
    if (!existsSync(target)) brokenImports.push({ file: rel(abs), imports: m[1], resolvesTo: rel(target) })
  }
}
if (brokenImports.length) {
  console.log('--- test files importing a module path that does not exist ---')
  console.log('    (discovered and RUN, but throw "Cannot find module" -> count as failing.')
  console.log('     Fix = re-run Coding for the element that owns the real file.)')
  for (const b of brokenImports) {
    console.log(`  ${b.file}`)
    console.log(`      imports ${b.imports}  ->  ${b.resolvesTo}  (missing)`)
  }
  console.log()
}

console.log('No changes written. The in-app heal (any coding run / test-file')
console.log('generation) applies the filePath resets above automatically.')
