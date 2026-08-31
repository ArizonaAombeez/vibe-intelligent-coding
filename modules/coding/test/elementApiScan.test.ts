import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ArchitectureElement, PlatformDescriptor } from 'vic-requirements-elicitation'
import { parseElementExports, scanElementApi, scanElementApis } from '../src/index.js'

const WEB: PlatformDescriptor = {
  id: 'web', label: 'Web App', builtIn: true,
  entryPointHint: 'index.html', wiringHint: 'ES module imports', lifecycleHint: 'start only',
}
const CLI: PlatformDescriptor = {
  id: 'cli', label: 'CLI', builtIn: true,
  entryPointHint: 'main()', wiringHint: 'constructor injection', lifecycleHint: 'start + SIGINT',
}

function el(id: string, name: string, kind: ArchitectureElement['kind'] = 'functional'): ArchitectureElement {
  return { id, kind, name, responsibility: 'x', row: 0, col: 0, rowSpan: 1, colSpan: 1, interfaces: [], elementInterfaces: [] }
}

// --- parseElementExports (pure) --------------------------------------------

test('parseElementExports: export function with params', () => {
  const out = parseElementExports(`export function createEngine(width, height) { return {} }`)
  assert.deepEqual(out, [{ name: 'createEngine', kind: 'function', params: 'width, height' }])
})

test('parseElementExports: export async function and no-arg function', () => {
  const out = parseElementExports(`
    export async function load(url) {}
    export function tick() {}
  `)
  assert.deepEqual(out, [
    { name: 'load', kind: 'function', params: 'url' },
    { name: 'tick', kind: 'function', params: '' },
  ])
})

test('parseElementExports: arrow-function const is treated as callable', () => {
  const out = parseElementExports(`export const step = (state, dt) => state`)
  assert.deepEqual(out, [{ name: 'step', kind: 'function', params: 'state, dt' }])
})

test('parseElementExports: plain const value is kind const with no params', () => {
  const out = parseElementExports(`export const DEFAULT_TICK_MS = 16`)
  assert.deepEqual(out, [{ name: 'DEFAULT_TICK_MS', kind: 'const' }])
})

test('parseElementExports: balanced parens in a default value are not truncated', () => {
  const out = parseElementExports(`export function make(a = fn(1, 2), { x = 0 } = {}) {}`)
  assert.equal(out.length, 1)
  assert.equal(out[0].params, 'a = fn(1, 2), { x = 0 } = {}')
})

test('parseElementExports: export class with constructor and methods', () => {
  const out = parseElementExports(`
    export class World {
      constructor(w, h) { this.w = w }
      advance(dt) {}
      snapshot() { return null }
    }
  `)
  assert.equal(out.length, 1)
  assert.equal(out[0].kind, 'class')
  assert.deepEqual(out[0].methods, ['constructor(w, h)', 'advance(dt)', 'snapshot()'])
})

test('parseElementExports: control-flow keywords inside a class body are not mistaken for methods', () => {
  const out = parseElementExports(`
    export class Runner {
      run() {
        if (this.done) return
        for (let i = 0; i < 3; i++) {}
      }
    }
  `)
  assert.deepEqual(out[0].methods, ['run()'])
})

test('parseElementExports: commented-out exports are ignored', () => {
  const out = parseElementExports(`
    // export function ghost() {}
    /* export const alsoGhost = 1 */
    export function real() {}
  `)
  assert.deepEqual(out, [{ name: 'real', kind: 'function', params: '' }])
})

test('parseElementExports: export { a, b as c } yields the exported names', () => {
  const out = parseElementExports(`
    function a() {}
    function b() {}
    export { a, b as publicB }
  `)
  assert.deepEqual(out.map((e) => e.name).sort(), ['a', 'publicB'])
})

test('parseElementExports: a name exported twice is de-duplicated', () => {
  const out = parseElementExports(`
    export function foo() {}
    export { foo }
  `)
  assert.equal(out.filter((e) => e.name === 'foo').length, 1)
})

// --- scanElementApi (filesystem) -----------------------------------------

test('scanElementApi: reads index.js under the element folder on web', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vic-elapi-'))
  try {
    await mkdir(path.join(dir, 'game-engine'), { recursive: true })
    await writeFile(
      path.join(dir, 'game-engine', 'index.js'),
      `export function createEngine(w, h) {}\nexport const DEFAULT = 1\n`,
      'utf-8',
    )
    const api = await scanElementApi(dir, el('ARCH-001', 'Game Engine'), WEB)
    assert.equal(api.scanned, true)
    assert.equal(api.folder, 'game-engine')
    assert.equal(api.entryFile, 'index.js')
    assert.deepEqual(api.exports.map((e) => e.name), ['createEngine', 'DEFAULT'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('scanElementApi: missing folder -> scanned false, entryFile still set (web)', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vic-elapi-'))
  try {
    const api = await scanElementApi(dir, el('ARCH-001', 'Not Built Yet'), WEB)
    assert.equal(api.scanned, false)
    assert.equal(api.entryFile, 'index.js')
    assert.deepEqual(api.exports, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('scanElementApi: non-web platform -> scanned false, no entryFile', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vic-elapi-'))
  try {
    await mkdir(path.join(dir, 'game-engine'), { recursive: true })
    await writeFile(path.join(dir, 'game-engine', 'index.js'), `export function x() {}`, 'utf-8')
    const api = await scanElementApi(dir, el('ARCH-001', 'Game Engine'), CLI)
    assert.equal(api.scanned, false)
    assert.equal(api.entryFile, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('scanElementApi: a bare re-export barrel is marked unscanned', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vic-elapi-'))
  try {
    await mkdir(path.join(dir, 'renderer'), { recursive: true })
    await writeFile(path.join(dir, 'renderer', 'index.js'), `export * from './draw.js'\n`, 'utf-8')
    const api = await scanElementApi(dir, el('ARCH-001', 'Renderer'), WEB)
    assert.equal(api.scanned, false)
    assert.equal(api.entryFile, 'index.js')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('scanElementApis: skips the harness element and preserves order', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vic-elapi-'))
  try {
    for (const f of ['a', 'b']) {
      await mkdir(path.join(dir, f), { recursive: true })
      await writeFile(path.join(dir, f, 'index.js'), `export function ${f}fn() {}`, 'utf-8')
    }
    const apis = await scanElementApis(
      dir,
      [el('ARCH-001', 'A'), el('ARCH-H', 'Harness', 'harness'), el('ARCH-002', 'B')],
      WEB,
    )
    assert.deepEqual(apis.map((a) => a.elementId), ['ARCH-001', 'ARCH-002'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
