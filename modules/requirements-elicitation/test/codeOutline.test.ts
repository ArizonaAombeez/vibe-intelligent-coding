import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scoreCodeFilesForGapScan, filterCodeFilesForGapScan } from '../src/index.js'

test('scoreCodeFilesForGapScan marks generated/vendored/lockfile paths as low signal', () => {
  const scores = scoreCodeFilesForGapScan([
    { path: 'dist/bundle.js', content: 'if (x) { throw new Error("boom") }' },
    { path: 'package-lock.json', content: '{}' },
    { path: 'src/auth.ts', content: 'if (x) { throw new Error("boom") }' },
  ])

  assert.equal(scores[0].lowSignal, true)
  assert.equal(scores[1].lowSignal, true)
  assert.equal(scores[2].lowSignal, false)
})

test('scoreCodeFilesForGapScan scores a file with more branching/error-handling higher than one without', () => {
  const scores = scoreCodeFilesForGapScan([
    { path: 'logic.ts', content: 'function f(x) {\n  if (x) { throw new Error("bad") }\n  return x\n}' },
    { path: 'constants.ts', content: 'export const MAX = 10\nexport const MIN = 0\n' },
  ])

  assert.ok(scores[0].signalScore > scores[1].signalScore)
})

test('filterCodeFilesForGapScan drops low-signal files and keeps the rest in original order', () => {
  const files = [
    { path: 'src/a.ts', content: 'if (x) { throw new Error("a") }' },
    { path: 'dist/bundle.js', content: 'if (x) { throw new Error("b") }' },
    { path: 'src/c.ts', content: 'if (x) { throw new Error("c") }' },
  ]

  const filtered = filterCodeFilesForGapScan(files)

  assert.deepEqual(
    filtered.map((f) => f.path),
    ['src/a.ts', 'src/c.ts'],
  )
})

test('filterCodeFilesForGapScan caps to maxFiles, keeping the highest-signal files in original order', () => {
  const files = [
    { path: 'src/low.ts', content: 'export const MAX = 10\n' },
    { path: 'src/high.ts', content: 'if (x) { throw new Error("a") } else { for (;;) { try {} catch {} } }' },
    { path: 'src/mid.ts', content: 'if (x) { return x }' },
  ]

  const filtered = filterCodeFilesForGapScan(files, 2)

  assert.deepEqual(
    filtered.map((f) => f.path),
    ['src/high.ts', 'src/mid.ts'],
  )
})

test('filterCodeFilesForGapScan returns everything unfiltered when maxFiles is omitted and nothing is low-signal', () => {
  const files = [
    { path: 'src/a.ts', content: 'const a = 1' },
    { path: 'src/b.ts', content: 'const b = 2' },
  ]

  assert.deepEqual(filterCodeFilesForGapScan(files), files)
})
