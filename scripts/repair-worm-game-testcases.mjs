// One-off reconciliation for the Worm Game project (Aug 2026).
//
// Background: the project's src/ tree was fully re-coded on 2026-08-29/30.
// That deleted every requirement-based test file that had previously been
// generated, but the 40 testSuite.tests records were left pointing at the
// old (now-missing) file paths. Result on the Test Execution screen:
//   - requirement-based tests never produce an outcome (attributeResults in
//     modules/testing/src/runExecution.ts matches by exact path identity,
//     and none of the 40 recorded paths exist on disk), so the "Test
//     Creation" column is permanently empty and requirement status never
//     moves;
//   - the surviving test files on disk belong to no test case at all.
//
// This script reconciles project.json to the real disk state:
//   - for every test case whose filePath is set but resolves to no file
//     under src/, clears filePath, resets status to 'not-run', clears
//     lastRunAt  -> the UI then honestly shows "Not generated" and the test
//     can be regenerated via "Generate All Test Case Automations".
//   - prints a report of what was reset, which on-disk test files are
//     orphaned (no owning test case), and any obvious module-resolution
//     mismatches in the interface tests.
//
// It does NOT touch codingRuns or testRuns history.
//
// Usage:
//   node scripts/repair-worm-game-testcases.mjs            (dry run - report only)
//   node scripts/repair-worm-game-testcases.mjs --write     (apply + back up)

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const PROJECT_DIR =
  process.env.WORM_GAME_DIR ?? 'Q:/VIC_Data/Worm Game_2026-08-04_01-45-00'
const PROJECT_JSON = path.join(PROJECT_DIR, 'project.json')
const SRC_ROOT = path.join(PROJECT_DIR, 'src')
const WRITE = process.argv.includes('--write')

const TEST_FILE_SUFFIX = /\.test\.[^./\\]+$/

function listTestFiles(dir, acc = []) {
  if (!existsSync(dir)) return acc
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      listTestFiles(full, acc)
    } else if (entry.isFile() && TEST_FILE_SUFFIX.test(entry.name)) {
      acc.push(full)
    }
  }
  return acc
}

function rel(p) {
  return path.relative(SRC_ROOT, p).split(path.sep).join('/')
}

if (!existsSync(PROJECT_JSON)) {
  console.error(`project.json not found at ${PROJECT_JSON}`)
  process.exit(1)
}

const project = JSON.parse(readFileSync(PROJECT_JSON, 'utf8'))
const tests = (project.testSuite?.tests ?? []).filter((t) => !t.deletedAt)

const onDisk = listTestFiles(SRC_ROOT)
const onDiskSet = new Set(onDisk.map(rel))

const reset = []
const stillValid = []
const neverGenerated = []

for (const t of tests) {
  if (!t.filePath) {
    neverGenerated.push(t)
    continue
  }
  const abs = path.resolve(SRC_ROOT, t.filePath)
  if (existsSync(abs) && statSync(abs).isFile()) {
    stillValid.push(t)
  } else {
    reset.push(t)
  }
}

// Orphan test files: on disk, but no test case claims them.
const claimed = new Set(stillValid.map((t) => t.filePath.split(path.sep).join('/')))
const orphans = [...onDiskSet].filter((p) => !claimed.has(p))

console.log('='.repeat(72))
console.log(`Worm Game test-case reconciliation  (${WRITE ? 'WRITE' : 'DRY RUN'})`)
console.log('='.repeat(72))
console.log(`project.json : ${PROJECT_JSON}`)
console.log(`src/         : ${SRC_ROOT}`)
console.log(`active test cases        : ${tests.length}`)
console.log(`  filePath valid on disk : ${stillValid.length}`)
console.log(`  filePath MISSING       : ${reset.length}   <- will be reset`)
console.log(`  never had a filePath   : ${neverGenerated.length}`)
console.log(`test files on disk       : ${onDisk.length}`)
console.log(`  orphaned (no owner)    : ${orphans.length}`)
console.log()

if (reset.length) {
  console.log('--- Test cases whose recorded file no longer exists (reset to "not generated") ---')
  for (const t of reset) {
    console.log(`  ${t.id}  [${t.type}]  status=${t.status}`)
    console.log(`      was: ${t.filePath}`)
  }
  console.log()
}

if (orphans.length) {
  console.log('--- Test files on disk with no owning requirement test case ---')
  console.log('    (these are the coding agent / harness SW tests; they run as SW outcomes,')
  console.log('     not requirement-traced ones)')
  for (const p of orphans.sort()) console.log(`  ${p}`)
  console.log()
}

// Cheap module-resolution sanity check on the interface tests: flag a
// require()/import of a relative .js path that doesn't exist on disk.
const IMPORT_RE = /(?:require\(|from\s+)['"](\.\.?\/[^'"]+\.(?:js|mjs|cjs))['"]/g
const brokenImports = []
for (const abs of onDisk) {
  const body = readFileSync(abs, 'utf8')
  for (const m of body.matchAll(IMPORT_RE)) {
    const target = path.resolve(path.dirname(abs), m[1])
    if (!existsSync(target)) {
      brokenImports.push({ file: rel(abs), imports: m[1], resolvesTo: rel(target) })
    }
  }
}
if (brokenImports.length) {
  console.log('--- Test files importing a module path that does not exist ---')
  console.log('    (these tests are discovered and RUN, but throw "Cannot find module" -')
  console.log('     they count as failing, not "not run". Fix = re-run Coding for the')
  console.log('     element that owns the real file, or correct the generated import.)')
  for (const b of brokenImports) {
    console.log(`  ${b.file}`)
    console.log(`      imports: ${b.imports}`)
    console.log(`      -> ${b.resolvesTo}  (missing)`)
  }
  console.log()
}

// Test cases whose file exists but imports a module that doesn't resolve
// (the mechanical signal that the generated test is out of sync with the
// current code — e.g. written against an engine API that a later recode
// replaced). Their persisted status ('failing') is stale and misleading;
// reset it to 'not-run' so a fresh run establishes the real result. The
// file is left in place — regenerating it is the user's call.
const brokenImportFiles = new Set(brokenImports.map((b) => b.file))
const staleStatusReset = stillValid.filter(
  (t) => t.status && t.status !== 'not-run' && brokenImportFiles.has(t.filePath.split(path.sep).join('/')),
)
if (staleStatusReset.length) {
  console.log('--- Test cases with a stale pass/fail status (file out of sync with current code) ---')
  console.log('    status will be reset to "not-run"; the file is left in place')
  for (const t of staleStatusReset) console.log(`  ${t.id}  status=${t.status} -> not-run   (${t.filePath})`)
  console.log()
}

if (!WRITE) {
  console.log('Dry run - no changes written. Re-run with --write to apply.')
  process.exit(0)
}

if (reset.length === 0 && staleStatusReset.length === 0) {
  console.log('Nothing to reset. project.json left unchanged.')
  process.exit(0)
}

const backup = `${PROJECT_JSON}.pre-testcase-repair-${Date.now()}.bak`
writeFileSync(backup, readFileSync(PROJECT_JSON))
console.log(`Backed up project.json -> ${backup}`)

const resetIds = new Set(reset.map((t) => t.id))
const staleStatusIds = new Set(staleStatusReset.map((t) => t.id))
for (const t of project.testSuite.tests) {
  if (resetIds.has(t.id)) {
    delete t.filePath
    t.status = 'not-run'
    delete t.lastRunAt
  } else if (staleStatusIds.has(t.id)) {
    t.status = 'not-run'
    delete t.lastRunAt
  }
}

writeFileSync(PROJECT_JSON, JSON.stringify(project, null, 2))
console.log(
  `Reset ${reset.length} missing-file test case(s) and ${staleStatusReset.length} stale-status test case(s). project.json written.`,
)
console.log('Next:')
console.log('  - Test Creation -> "Generate All Test Case Automations" to regenerate the 33 functional test files.')
if (brokenImports.length) {
  console.log(
    '  - The interface tests are written against a superseded engine API. Regenerate them (delete + Generate Test File),',
  )
  console.log('    or re-run Coding for Game Engine / the Harness so a matching engine + tests are produced together.')
}
