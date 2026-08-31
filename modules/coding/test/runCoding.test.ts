import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ClaudeCodeAgentClient } from 'vic-llm-claude-code'
import type { Project } from 'vic-requirements-elicitation'
import {
  buildCodingPrompt,
  runCodingForElement,
  sourceTreeRoot,
  interfaceChangedSinceLastCoding,
} from '../src/index.js'

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'llm',
  'claude-code',
  'test',
  'fixtures',
  'fake-claude-agent.mjs',
)

async function tempProjectDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'vic-runcoding-test-'))
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

// Element/requirement-based fixture (element-based Coding rewrite) —
// replaces the old Story-based baseProject/storyFor helpers. REQ-001 is
// allocated to ARCH-001 ('Login UI') via architectureElements, no Story
// involved at all.
// Interface-gate requirement (Area B/D): an element can't reach Coding
// until its own connected interfaces are fully defined (range/resolution/
// unit/update-frequency on every operation), so the fixture's ARCH-001 <->
// ARCH-002 connection carries a fully-specified contract by default — tests
// exercising the gate itself override/clear this per test.
function baseProject(): Project {
  return {
    schemaVersion: 1,
    id: 'proj-1',
    name: 'Test',
    projectMode: 'new',
    requirements: [
      {
        id: 'REQ-001',
        text: 'The system shall render a login form',
        type: null,
        status: 'allocated',
        createdAt: new Date().toISOString(),
        provenance: 'human',
        architectureElements: ['ARCH-001'],
      },
    ],
    architecture: {
      layers: ['Core'],
      elements: [
        { id: 'ARCH-001', kind: 'functional', name: 'Login UI', responsibility: 'Renders login', row: 0, col: 0, rowSpan: 1, colSpan: 1, interfaces: ['ARCH-002'], elementInterfaces: [] },
        { id: 'ARCH-002', kind: 'service', name: 'Auth Service', responsibility: 'Authenticates users', row: 0, col: 1, rowSpan: 1, colSpan: 1, interfaces: [], elementInterfaces: [] },
      ],
      nextElementSeq: 3,
      nextInterfaceSeq: 2,
      interfaceDefinitions: [
        {
          id: 'IFACE-001',
          name: 'Login UI <-> Auth Service',
          participants: [
            { elementId: 'ARCH-001', role: 'both' },
            { elementId: 'ARCH-002', role: 'both' },
          ],
          status: 'defined',
          updatedAt: new Date().toISOString(),
          operations: [
            {
              name: 'login',
              description: 'Authenticates a user',
              request: 'username, password',
              response: 'sessionToken',
              errors: 'InvalidCredentials',
              range: 'N/A',
              resolution: 'N/A',
              unit: 'N/A',
              updateFrequency: 'on user action',
            },
          ],
        },
      ],
    },
  }
}

test('runCodingForElement: an in-scope write is committed, diff captured, status success', async () => {
  process.env.FAKE_CLAUDE_MODE = 'write-in-scope'
  // Relative to the agent's own cwd, which is already the isolated copy of
  // this element's own folder (see isolatedWorkspace.ts) — not prefixed
  // with the element's folder name, unlike the pre-isolation shared-tree
  // model this fixture path used to assume.
  process.env.FAKE_CLAUDE_WRITE_PATH = 'generated.txt'
  const dir = await tempProjectDir()
  try {
    const project = baseProject()
    const client = new ClaudeCodeAgentClient()

    const run = await runCodingForElement(project, dir, 'ARCH-001', client, { binary: 'node', binaryArgs: [fixture] })

    assert.equal(run.status, 'success')
    assert.equal(run.allowedSubfolder, 'login-ui')
    assert.equal(run.architectureElementId, 'ARCH-001')
    assert.match(run.diff, /generated\.txt/)
    assert.ok(await exists(path.join(sourceTreeRoot(dir), 'login-ui', 'generated.txt')))
  } finally {
    await rm(dir, { recursive: true, force: true })
    delete process.env.FAKE_CLAUDE_WRITE_PATH
  }
})

// "rejected-scope" is no longer a reachable outcome for an element-only run
// (see runCoding.ts's comment on this: it's a physical impossibility now,
// not a detect-and-revert policy check) — the agent's cwd is jailed inside
// a throwaway copy of only this element's own folder, so a write outside it
// (simulated here via a relative '../' escape) lands outside the isolated
// root entirely and is simply never seen by the merge-back step, which only
// ever looks inside the element's own folder. From the real project's
// perspective this is indistinguishable from the agent writing nothing at
// all inside its own scope — changedPaths comes back empty — so it's
// correctly caught by the same empty-output guard runCoding.ts uses for a
// genuine no-op run (status 'rejected-empty-output'), not silently reported
// as 'success'.
test('runCodingForElement: a write outside the isolated element folder never reaches the real project', async () => {
  process.env.FAKE_CLAUDE_MODE = 'write-out-of-scope'
  process.env.FAKE_CLAUDE_WRITE_PATH = '../auth-service/escaped.txt'
  const dir = await tempProjectDir()
  try {
    const project = baseProject()
    const client = new ClaudeCodeAgentClient()

    const run = await runCodingForElement(project, dir, 'ARCH-001', client, { binary: 'node', binaryArgs: [fixture] })

    assert.equal(run.status, 'rejected-empty-output')
    assert.equal(run.diff, '')
    // Real filesystem assertion, not just the returned status/diff: the
    // escaped write must never have reached the real project directory at
    // all — it was physically impossible for it to, since the agent's cwd
    // never included any path outside its own isolated element folder.
    assert.equal(await exists(path.join(sourceTreeRoot(dir), 'auth-service', 'escaped.txt')), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
    delete process.env.FAKE_CLAUDE_WRITE_PATH
  }
})

test('runCodingForElement: an out-of-scope write does not clobber a legitimately in-scope file from the same run', async () => {
  process.env.FAKE_CLAUDE_MODE = 'write-out-of-scope'
  process.env.FAKE_CLAUDE_WRITE_PATH = '../auth-service/escaped.txt'
  const dir = await tempProjectDir()
  try {
    const project = baseProject()
    const client = new ClaudeCodeAgentClient()

    // Pre-seed an in-scope file that already existed before this run, to
    // confirm an out-of-scope write attempt (which never reaches the real
    // project at all under isolation — see the test above) leaves this
    // pre-existing in-scope file completely undisturbed.
    const { mkdir, writeFile } = await import('node:fs/promises')
    const { scaffoldProjectSourceTree, gitInitIfNeeded, gitCommitAll } = await import('../src/index.js')
    await scaffoldProjectSourceTree(project, dir)
    await mkdir(path.join(sourceTreeRoot(dir), 'login-ui'), { recursive: true })
    await writeFile(path.join(sourceTreeRoot(dir), 'login-ui', 'existing.txt'), 'pre-existing', 'utf8')
    await gitInitIfNeeded(sourceTreeRoot(dir))
    await gitCommitAll(sourceTreeRoot(dir), 'seed')

    await runCodingForElement(project, dir, 'ARCH-001', client, { binary: 'node', binaryArgs: [fixture] })

    const content = await (await import('node:fs/promises')).readFile(
      path.join(sourceTreeRoot(dir), 'login-ui', 'existing.txt'),
      'utf8',
    )
    assert.equal(content, 'pre-existing')
  } finally {
    await rm(dir, { recursive: true, force: true })
    delete process.env.FAKE_CLAUDE_WRITE_PATH
  }
})

test('runCodingForElement: an unknown architecture element id is rejected before any subprocess is spawned', async () => {
  process.env.FAKE_CLAUDE_MODE = 'ok'
  const dir = await tempProjectDir()
  try {
    const project = baseProject()
    // Give the (nonexistent) element an eligible requirement so eligibility
    // isn't what trips the rejection — this is testing the "element not
    // found" path specifically.
    project.requirements.push({
      id: 'REQ-999',
      text: 'Orphaned requirement',
      type: null,
      status: 'allocated',
      createdAt: new Date().toISOString(),
      provenance: 'human',
      architectureElements: ['ARCH-999'],
    })
    const client = new ClaudeCodeAgentClient()
    let spawnCount = 0
    const originalRunAgentTask = client.runAgentTask.bind(client)
    client.runAgentTask = async (...args) => {
      spawnCount++
      return originalRunAgentTask(...args)
    }

    const run = await runCodingForElement(project, dir, 'ARCH-999', client, { binary: 'node', binaryArgs: [fixture] })

    assert.equal(run.status, 'rejected-not-eligible')
    assert.equal(spawnCount, 0, 'the CLI must never be spawned for an unknown element')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// No shared-scope conflict is possible anymore (Area B/D, resolved): a
// requirement allocated to two elements simply appears in both elements'
// own requirement lists — each Coding run still targets exactly one
// element's own folder. This replaces the old "2 elements -> shared
// -interface subfolder" story-based test.
test('runCodingForElement: a requirement allocated to two elements still scopes a run to exactly one element\'s own folder', async () => {
  process.env.FAKE_CLAUDE_MODE = 'write-in-scope'
  process.env.FAKE_CLAUDE_WRITE_PATH = 'generated.ts'
  const dir = await tempProjectDir()
  try {
    const project = baseProject()
    project.requirements[0].architectureElements = ['ARCH-001', 'ARCH-002']
    const client = new ClaudeCodeAgentClient()

    const run = await runCodingForElement(project, dir, 'ARCH-002', client, { binary: 'node', binaryArgs: [fixture] })

    assert.equal(run.status, 'success')
    assert.equal(run.allowedSubfolder, 'auth-service')
    assert.equal(run.architectureElementId, 'ARCH-002')
  } finally {
    await rm(dir, { recursive: true, force: true })
    delete process.env.FAKE_CLAUDE_WRITE_PATH
  }
})

test('runCodingForElement: an element with no allocated requirement at "allocated" status is rejected before any subprocess is spawned', async () => {
  process.env.FAKE_CLAUDE_MODE = 'ok'
  const dir = await tempProjectDir()
  try {
    const project = baseProject()
    project.requirements[0].status = 'complete'
    const client = new ClaudeCodeAgentClient()
    let spawnCount = 0
    const originalRunAgentTask = client.runAgentTask.bind(client)
    client.runAgentTask = async (...args) => {
      spawnCount++
      return originalRunAgentTask(...args)
    }

    const run = await runCodingForElement(project, dir, 'ARCH-001', client, { binary: 'node', binaryArgs: [fixture] })

    assert.equal(run.status, 'rejected-not-eligible')
    assert.equal(spawnCount, 0, 'the CLI must never be spawned for a not-eligible element')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runCodingForElement: an element with at least one allocated requirement among several proceeds normally', async () => {
  process.env.FAKE_CLAUDE_MODE = 'write-in-scope'
  process.env.FAKE_CLAUDE_WRITE_PATH = 'generated.txt'
  // T3.3: the fixture's test file must tag every allocated requirement or
  // the loop keeps iterating for coverage.
  process.env.FAKE_CLAUDE_COVERS = 'REQ-001 REQ-002'
  const dir = await tempProjectDir()
  try {
    const project = baseProject()
    project.requirements.push({
      id: 'REQ-002',
      text: 'The system shall show a validation error',
      type: null,
      status: 'complete',
      createdAt: new Date().toISOString(),
      provenance: 'human',
      architectureElements: ['ARCH-001'],
    })
    const client = new ClaudeCodeAgentClient()

    const run = await runCodingForElement(project, dir, 'ARCH-001', client, { binary: 'node', binaryArgs: [fixture] })

    assert.equal(run.status, 'success')
  } finally {
    await rm(dir, { recursive: true, force: true })
    delete process.env.FAKE_CLAUDE_WRITE_PATH
    delete process.env.FAKE_CLAUDE_COVERS
  }
})

test('runCodingForElement: a run that writes code but no *.test.* file is rejected-no-tests (code still committed, not counted as success)', async () => {
  process.env.FAKE_CLAUDE_MODE = 'write-in-scope'
  process.env.FAKE_CLAUDE_WRITE_PATH = 'generated.txt'
  process.env.FAKE_CLAUDE_NO_TEST = '1' // suppress the fixture's companion test file
  const dir = await tempProjectDir()
  try {
    const project = baseProject()
    const client = new ClaudeCodeAgentClient()

    const run = await runCodingForElement(project, dir, 'ARCH-001', client, { binary: 'node', binaryArgs: [fixture] })

    assert.equal(run.status, 'rejected-no-tests')
    // The code the agent wrote is kept (merged + committed) — discarding
    // real work over a missing test would be worse.
    assert.ok(run.diff.includes('generated.txt'), 'the written code should still be in the committed diff')
    assert.ok(
      await exists(path.join(sourceTreeRoot(dir), 'login-ui', 'generated.txt')),
      'the code file should be present on disk',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
    delete process.env.FAKE_CLAUDE_WRITE_PATH
    delete process.env.FAKE_CLAUDE_NO_TEST
  }
})

test('runCodingForElement: a run that writes a *.test.mjs alongside code is success', async () => {
  process.env.FAKE_CLAUDE_MODE = 'write-in-scope'
  process.env.FAKE_CLAUDE_WRITE_PATH = 'generated.txt' // fixture also drops generated.test.mjs
  const dir = await tempProjectDir()
  try {
    const project = baseProject()
    const client = new ClaudeCodeAgentClient()

    const run = await runCodingForElement(project, dir, 'ARCH-001', client, { binary: 'node', binaryArgs: [fixture] })

    assert.equal(run.status, 'success')
    assert.ok(
      await exists(path.join(sourceTreeRoot(dir), 'login-ui', 'generated.test.mjs')),
      'the mandatory test file should be present',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
    delete process.env.FAKE_CLAUDE_WRITE_PATH
  }
})

test('runCodingForElement: an agent that drops a node_modules/ (ran npm install) does not break git add / the merge-back', async () => {
  const dir = await tempProjectDir()
  try {
    const project = baseProject()
    let call = 0
    const client = {
      async runAgentTask(_p: string, o: { cwd: string }) {
        call++
        const { writeFile, mkdir } = await import('node:fs/promises')
        // Real code + a covering test...
        await writeFile(path.join(o.cwd, 'renderer.js'), 'export function draw(){}\n', 'utf8')
        await writeFile(path.join(o.cwd, 'renderer.test.mjs'), '// covers: REQ-001\nprocess.exit(0)\n', 'utf8')
        // ...plus a bogus node_modules the agent should never have created.
        // Includes a nested dir + a lockfile, the exact shape that produced
        // the "git add failed … Permission denied … failed to insert into
        // database" cli-error.
        await mkdir(path.join(o.cwd, 'node_modules', '.bin'), { recursive: true })
        await writeFile(path.join(o.cwd, 'node_modules', '.bin', 'prebuild-install'), '#!/bin/sh\n', 'utf8')
        await mkdir(path.join(o.cwd, 'node_modules', 'napi-build-utils'), { recursive: true })
        await writeFile(path.join(o.cwd, 'node_modules', 'napi-build-utils', 'index.js'), 'module.exports={}\n', 'utf8')
        await writeFile(path.join(o.cwd, 'package-lock.json'), '{"lockfileVersion":3}\n', 'utf8')
        return { rawLog: `iter ${call}`, exitCode: 0, providerId: 'claude-code' as const, sessionId: 's', timing: { msTotal: 5 } }
      },
    }

    const run = await runCodingForElement(project, dir, 'ARCH-001', client, {})

    assert.equal(run.status, 'success', 'the run should succeed despite the stray node_modules')
    const scope = path.join(sourceTreeRoot(dir), 'login-ui')
    assert.ok(await exists(path.join(scope, 'renderer.js')), 'real code merged back')
    assert.ok(await exists(path.join(scope, 'renderer.test.mjs')), 'test file merged back')
    assert.equal(await exists(path.join(scope, 'node_modules')), false, 'node_modules must NOT be synced onto the project tree')
    assert.equal(await exists(path.join(scope, 'package-lock.json')), false, 'lockfile must NOT be synced back')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// --- T3 coding loop --------------------------------------------------------

test('runCodingForElement (loop): converges — a first iteration with a failing test, a second that fixes it, then done', async () => {
  const dir = await tempProjectDir()
  try {
    const project = baseProject()
    let call = 0
    const client = {
      async runAgentTask(prompt: string, o: { cwd: string; resumeSessionId?: string }) {
        call++
        const { writeFile } = await import('node:fs/promises')
        await writeFile(path.join(o.cwd, 'engine.js'), `// v${call}\nexport const ok = ${call >= 2}\n`, 'utf8')
        // Iteration 1: a test that FAILS (exit 1). Iteration 2: passes.
        const body =
          call === 1
            ? '// covers: REQ-001\nprocess.exit(1)\n'
            : '// covers: REQ-001\nprocess.exit(0)\n'
        await writeFile(path.join(o.cwd, 'engine.test.mjs'), body, 'utf8')
        // The 2nd call must be a resumed session (continuity).
        if (call === 2) assert.equal(o.resumeSessionId, 'sess-1', 'iteration 2 resumes iteration 1\'s session')
        return { rawLog: `iter ${call}`, exitCode: 0, providerId: 'claude-code' as const, sessionId: 'sess-1', timing: { msTotal: 5 } }
      },
    }

    const run = await runCodingForElement(project, dir, 'ARCH-001', client, {})

    assert.equal(run.status, 'success')
    assert.equal(run.stoppedBecause, 'done')
    assert.equal(run.iterations, 2)
    assert.equal(call, 2)
    assert.equal(run.swTestResult?.passed, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runCodingForElement (loop): a persistently failing test ends success-tests-failing via the stall check, not the cap', async () => {
  const dir = await tempProjectDir()
  try {
    const project = baseProject()
    let call = 0
    const client = {
      async runAgentTask(_p: string, o: { cwd: string }) {
        call++
        const { writeFile } = await import('node:fs/promises')
        // Same code + same failing test every time -> no new diff after
        // iteration 1, same failing set -> stall.
        await writeFile(path.join(o.cwd, 'engine.js'), '// fixed content\n', 'utf8')
        await writeFile(path.join(o.cwd, 'engine.test.mjs'), '// covers: REQ-001\nprocess.exit(1)\n', 'utf8')
        return { rawLog: `iter ${call}`, exitCode: 0, providerId: 'claude-code' as const, sessionId: 's', timing: { msTotal: 5 } }
      },
    }

    const run = await runCodingForElement(project, dir, 'ARCH-001', client, {})

    assert.equal(run.status, 'success-tests-failing')
    assert.equal(run.stoppedBecause, 'stalled')
    assert.ok((run.iterations ?? 0) >= 2 && (run.iterations ?? 0) < 8, 'stopped by stall, well before the cap')
    assert.equal(run.swTestResult?.passed, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runCodingForElement (loop): passing tests but an uncovered requirement ends success-tests-failing', async () => {
  const dir = await tempProjectDir()
  try {
    const project = baseProject()
    project.requirements.push({
      id: 'REQ-002',
      text: 'Second requirement',
      type: null,
      status: 'allocated',
      createdAt: new Date().toISOString(),
      provenance: 'human',
      architectureElements: ['ARCH-001'],
    })
    let call = 0
    const client = {
      async runAgentTask(_p: string, o: { cwd: string }) {
        call++
        const { writeFile } = await import('node:fs/promises')
        await writeFile(path.join(o.cwd, 'engine.js'), '// static\n', 'utf8')
        // Tags REQ-001 but never REQ-002 -> coverage gap that never closes.
        await writeFile(path.join(o.cwd, 'engine.test.mjs'), '// covers: REQ-001\nprocess.exit(0)\n', 'utf8')
        return { rawLog: `iter ${call}`, exitCode: 0, providerId: 'claude-code' as const, sessionId: 's', timing: { msTotal: 5 } }
      },
    }

    const run = await runCodingForElement(project, dir, 'ARCH-001', client, {})

    assert.equal(run.status, 'success-tests-failing')
    // The coverage gap is recorded on the iteration that produced code.
    const codingIter = run.iterationHistory?.find((h) => h.status === 'success')
    assert.deepEqual(codingIter?.uncoveredRequirementIds, ['REQ-002'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runCodingForElement (loop): an abort signal stops the loop, not just the current CLI call', async () => {
  const dir = await tempProjectDir()
  try {
    const project = baseProject()
    const ac = new AbortController()
    let call = 0
    const client = {
      async runAgentTask(_p: string, o: { cwd: string }) {
        call++
        const { writeFile } = await import('node:fs/promises')
        await writeFile(path.join(o.cwd, 'engine.js'), `// v${call}\n`, 'utf8')
        await writeFile(path.join(o.cwd, 'engine.test.mjs'), '// covers: REQ-001\nprocess.exit(1)\n', 'utf8')
        ac.abort() // request cancel after the first iteration's call
        return { rawLog: `iter ${call}`, exitCode: 0, providerId: 'claude-code' as const, sessionId: 's', timing: { msTotal: 5 } }
      },
    }

    const run = await runCodingForElement(project, dir, 'ARCH-001', client, { signal: ac.signal })

    assert.equal(call, 1, 'the loop must not start a second iteration after abort')
    assert.equal(run.stoppedBecause, 'cancelled')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('buildCodingPrompt: a non-harness element is NOT told to write under its own <prefix>/ (T1.1 — cwd already IS the element folder)', () => {
  const project = baseProject()
  const prompt = buildCodingPrompt(project, 'ARCH-001', 'login-ui', 'initial-build', {
    id: 'web',
    label: 'Web App',
    builtIn: true,
    entryPointHint: 'index.html',
    wiringHint: 'main.js',
    lifecycleHint: 'DOMContentLoaded',
  })
  // The doubled-folder bug was the prompt saying "under login-ui/ relative
  // to your working directory" while cwd was already login-ui/.
  assert.ok(!/under `?login-ui\/`? relative to your working directory/.test(prompt))
  assert.ok(!/from `?login-ui\/`? as the working directory/.test(prompt))
  assert.ok(!/at `?login-ui\/index\.js`?/.test(prompt))
  // It SHOULD tell the agent the cwd is the element folder and to write in it.
  assert.match(prompt, /working directory IS this element's own folder/i)
  assert.match(prompt, /do NOT create a "login-ui" subfolder/i)
})

test('buildCodingPrompt: still tells the agent the runnable test-file contract (T1.4)', () => {
  const project = baseProject()
  const prompt = buildCodingPrompt(project, 'ARCH-001', 'login-ui', 'initial-build')
  assert.match(prompt, /\.test\.<ext>/)
  assert.match(prompt, /\.test\.ts .* silently skipped/i)
  assert.match(prompt, /covers: IMP_REQ/i)
})

test('runCodingForElement: an element with an undefined connected interface is rejected before any subprocess is spawned', async () => {
  process.env.FAKE_CLAUDE_MODE = 'ok'
  const dir = await tempProjectDir()
  try {
    const project = baseProject()
    project.architecture!.interfaceDefinitions = []
    const client = new ClaudeCodeAgentClient()
    let spawnCount = 0
    const originalRunAgentTask = client.runAgentTask.bind(client)
    client.runAgentTask = async (...args) => {
      spawnCount++
      return originalRunAgentTask(...args)
    }

    const run = await runCodingForElement(project, dir, 'ARCH-001', client, { binary: 'node', binaryArgs: [fixture] })

    assert.equal(run.status, 'rejected-not-eligible')
    assert.match(run.rawLog, /not fully defined/)
    assert.equal(spawnCount, 0, 'the CLI must never be spawned while the element\'s interfaces are undefined')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runCodingForElement: an element whose interface operation is missing range/resolution/unit/update-frequency is rejected', async () => {
  process.env.FAKE_CLAUDE_MODE = 'ok'
  const dir = await tempProjectDir()
  try {
    const project = baseProject()
    project.architecture!.interfaceDefinitions![0].operations[0].range = undefined
    project.architecture!.interfaceDefinitions![0].operations[0].updateFrequency = undefined
    const client = new ClaudeCodeAgentClient()
    let spawnCount = 0
    const originalRunAgentTask = client.runAgentTask.bind(client)
    client.runAgentTask = async (...args) => {
      spawnCount++
      return originalRunAgentTask(...args)
    }

    const run = await runCodingForElement(project, dir, 'ARCH-001', client, { binary: 'node', binaryArgs: [fixture] })

    assert.equal(run.status, 'rejected-not-eligible')
    assert.match(run.rawLog, /missing I\/O detail/)
    assert.equal(spawnCount, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runCodingForElement: an element with an aligned:false interface copy is rejected before any subprocess is spawned', async () => {
  process.env.FAKE_CLAUDE_MODE = 'ok'
  const dir = await tempProjectDir()
  try {
    const project = baseProject()
    const element = project.architecture!.elements.find((e) => e.id === 'ARCH-001')!
    element.elementInterfaces = [
      { masterDefinitionId: 'IFACE-001', role: 'both', operations: [], aligned: false },
    ]
    const client = new ClaudeCodeAgentClient()
    let spawnCount = 0
    const originalRunAgentTask = client.runAgentTask.bind(client)
    client.runAgentTask = async (...args) => {
      spawnCount++
      return originalRunAgentTask(...args)
    }

    const run = await runCodingForElement(project, dir, 'ARCH-001', client, { binary: 'node', binaryArgs: [fixture] })

    assert.equal(run.status, 'rejected-not-eligible')
    assert.match(run.rawLog, /out-of-date copy/)
    assert.equal(spawnCount, 0, 'the CLI must never be spawned while the element has an unreconciled interface change')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// Real-world corruption case (not merely "out of date" — see the
// misaligned test above): an element's own interface copy points at a
// masterDefinitionId with no matching interfaceDefinitions entry at all,
// e.g. a historical "IFACE-undefined" id. This must hard-block Coding with
// a distinct, actionable message rather than either silently proceeding
// (the old bug — otherParticipantNames rendered the broken id straight
// into the prompt as "Interface contract with IFACE-undefined") or being
// folded into the misaligned wording, which would wrongly suggest
// reconciling against a real master would fix it.
test('runCodingForElement: an element with a dangling (broken) interface reference is rejected before any subprocess is spawned', async () => {
  process.env.FAKE_CLAUDE_MODE = 'ok'
  const dir = await tempProjectDir()
  try {
    const project = baseProject()
    const element = project.architecture!.elements.find((e) => e.id === 'ARCH-001')!
    element.elementInterfaces = [
      { masterDefinitionId: 'IFACE-undefined', role: 'both', operations: [], aligned: true },
    ]
    const client = new ClaudeCodeAgentClient()
    let spawnCount = 0
    const originalRunAgentTask = client.runAgentTask.bind(client)
    client.runAgentTask = async (...args) => {
      spawnCount++
      return originalRunAgentTask(...args)
    }

    const run = await runCodingForElement(project, dir, 'ARCH-001', client, { binary: 'node', binaryArgs: [fixture] })

    assert.equal(run.status, 'rejected-not-eligible')
    assert.match(run.rawLog, /broken reference/)
    assert.match(run.rawLog, /IFACE-undefined/)
    assert.equal(spawnCount, 0, 'the CLI must never be spawned while the element has a dangling interface reference')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('interfaceChangedSinceLastCoding: false when the element has never been coded successfully', () => {
  const project = baseProject()
  assert.equal(interfaceChangedSinceLastCoding(project, 'ARCH-001'), false)
})

test('interfaceChangedSinceLastCoding: false while the element still has an aligned:false interface copy', () => {
  const project = baseProject()
  const element = project.architecture!.elements.find((e) => e.id === 'ARCH-001')!
  element.elementInterfaces = [
    { masterDefinitionId: 'IFACE-001', role: 'both', operations: [], aligned: false },
  ]
  project.codingRuns = [
    {
      id: 'RUN-1',
      architectureElementId: 'ARCH-001',
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(0).toISOString(),
      status: 'success',
      diff: '',
      rawLog: '',
      exitCode: 0,
      allowedSubfolder: 'login-ui',
    },
  ]
  assert.equal(interfaceChangedSinceLastCoding(project, 'ARCH-001'), false)
})

test('interfaceChangedSinceLastCoding: true once the element is realigned and the master changed after its last successful run', () => {
  const project = baseProject()
  const element = project.architecture!.elements.find((e) => e.id === 'ARCH-001')!
  element.elementInterfaces = [
    { masterDefinitionId: 'IFACE-001', role: 'both', operations: [], aligned: true },
  ]
  project.architecture!.interfaceDefinitions![0].updatedAt = new Date(2000).toISOString()
  project.codingRuns = [
    {
      id: 'RUN-1',
      architectureElementId: 'ARCH-001',
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(1000).toISOString(),
      status: 'success',
      diff: '',
      rawLog: '',
      exitCode: 0,
      allowedSubfolder: 'login-ui',
    },
  ]
  assert.equal(interfaceChangedSinceLastCoding(project, 'ARCH-001'), true)
})

test('runCodingForElement: "recode from scratch" wipe followed by a no-op agent run is rejected, folder left empty rather than silently committed', async () => {
  const dir = await tempProjectDir()
  try {
    const project = baseProject()
    const client = new ClaudeCodeAgentClient()

    // First run: agent actually writes the element's file, gets committed —
    // this is the "existing implementation" a later recode-from-scratch
    // will wipe.
    process.env.FAKE_CLAUDE_MODE = 'write-in-scope'
    process.env.FAKE_CLAUDE_WRITE_PATH = 'index.html'
    const firstRun = await runCodingForElement(project, dir, 'ARCH-001', client, { binary: 'node', binaryArgs: [fixture] })
    assert.equal(firstRun.status, 'success')
    const filePath = path.join(sourceTreeRoot(dir), 'login-ui', 'index.html')
    assert.ok(await exists(filePath))

    // Simulate wipeScopedSubfolder: a raw filesystem delete (not a git
    // commit) of the element's folder, as "recode from scratch" performs
    // before re-running the agent. This is a deliberate, user-requested
    // discard of the old implementation — no backup is taken at this layer
    // (by design: the user explicitly asked to start over).
    await rm(path.join(sourceTreeRoot(dir), 'login-ui'), { recursive: true, force: true })
    await mkdir(path.join(sourceTreeRoot(dir), 'login-ui'), { recursive: true })

    // Second run: the agent CLI exits 0 with no error but writes nothing
    // (mode 'ok') — the silent no-op this guard exists to catch.
    process.env.FAKE_CLAUDE_MODE = 'ok'
    delete process.env.FAKE_CLAUDE_WRITE_PATH
    const secondRun = await runCodingForElement(project, dir, 'ARCH-001', client, { binary: 'node', binaryArgs: [fixture] })

    // Correct behavior: the run is flagged rejected-empty-output (not
    // silently reported as success — this is the exact class of bug that
    // left real elements holding nothing but their marker file), and the
    // element's folder is left empty rather than either committed as a
    // deletion or auto-restored — restoring old code the user explicitly
    // asked to discard would mask that the recode genuinely failed.
    assert.equal(secondRun.status, 'rejected-empty-output')
    assert.equal(secondRun.diff, '')
    assert.equal(await exists(filePath), false, 'the wiped folder should stay empty, not be auto-restored or left committed as a deletion')
  } finally {
    await rm(dir, { recursive: true, force: true })
    delete process.env.FAKE_CLAUDE_MODE
    delete process.env.FAKE_CLAUDE_WRITE_PATH
  }
})

test('runCodingForElement: a CLI-level failure returns status cli-error without touching the scope gate', async () => {
  process.env.FAKE_CLAUDE_MODE = 'nonzero-exit'
  const dir = await tempProjectDir()
  try {
    const project = baseProject()
    const client = new ClaudeCodeAgentClient()

    const run = await runCodingForElement(project, dir, 'ARCH-001', client, { binary: 'node', binaryArgs: [fixture] })

    assert.equal(run.status, 'cli-error')
    assert.equal(run.diff, '')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// GLM/OpenCode-specific in-iteration retry (see runOneCodingIteration's
// runOnce/retry comment): GLM-5.x can drop tool-call deltas mid-stream,
// producing a clean exit with nothing written. Within ONE loop iteration
// that empty run is retried once. This exercises that against a stub
// CodingAgentClient. Note the T3 loop then does its own convergence work on
// top: after the first iteration lands code + a passing test, the loop's
// requirement-coverage check runs one more iteration (the stub keeps
// writing the same file → no-op → stall exit), so the agent is invoked
// 2 (iter 1: empty + GLM retry) + 1 (iter 2: no-op) = 3 times total.
test('runCodingForElement: an opencode run that writes nothing is retried once within an iteration, and a write on the retry lands', async () => {
  const dir = await tempProjectDir()
  try {
    const project = baseProject()
    let callCount = 0
    const client = {
      async runAgentTask(_prompt: string, runOptions: { cwd: string }) {
        callCount++
        if (callCount === 1) {
          return { rawLog: 'first attempt: no tool calls landed', exitCode: 0, providerId: 'opencode' as const, timing: { msTotal: 10 } }
        }
        const { writeFile } = await import('node:fs/promises')
        await writeFile(path.join(runOptions.cwd, 'index.html'), '<html></html>', 'utf8')
        await writeFile(path.join(runOptions.cwd, 'index.test.mjs'), '// covers: REQ-001\nprocess.exit(0)\n', 'utf8')
        return { rawLog: 'retry: wrote index.html', exitCode: 0, providerId: 'opencode' as const, timing: { msTotal: 10 } }
      },
    }

    const run = await runCodingForElement(project, dir, 'ARCH-001', client, {})

    // iter 1: empty + GLM retry (2 calls, lands code + covering test => done).
    assert.equal(callCount, 2, 'iteration 1: the empty first attempt then one GLM retry, which lands a covering test => loop is done')
    assert.equal(run.status, 'success')
    assert.equal(run.providerId, 'opencode')
    assert.ok(await exists(path.join(sourceTreeRoot(dir), 'login-ui', 'index.html')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runCodingForElement: an opencode iteration that writes nothing on both attempts stalls at rejected-empty-output', async () => {
  const dir = await tempProjectDir()
  try {
    const project = baseProject()
    let callCount = 0
    const client = {
      async runAgentTask() {
        callCount++
        return { rawLog: `attempt ${callCount}: no tool calls landed`, exitCode: 0, providerId: 'opencode' as const, timing: { msTotal: 10 } }
      },
    }

    const run = await runCodingForElement(project, dir, 'ARCH-001', client, {})

    // The GLM double-call is per iteration. iter 1: empty + GLM retry
    // (2 calls) => rejected-empty-output at attempt 0. iter 2: empty + GLM
    // retry (2 calls) => rejected-empty-output at attempt 1 => stall exit.
    // 2 + 2 = 4.
    assert.equal(callCount, 4)
    assert.equal(run.status, 'rejected-empty-output')
    assert.equal(run.diff, '')
    assert.equal(run.stoppedBecause, 'stalled')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// The GLM double-call is genuinely provider-scoped; Claude Code gets one
// call per iteration.
test('runCodingForElement: a claude-code iteration that writes nothing is not double-called; the loop retries once then stalls', async () => {
  const dir = await tempProjectDir()
  try {
    const project = baseProject()
    let callCount = 0
    const client = {
      async runAgentTask() {
        callCount++
        return { rawLog: 'no-op run', exitCode: 0, providerId: 'claude-code' as const, timing: { msTotal: 10 } }
      },
    }

    const run = await runCodingForElement(project, dir, 'ARCH-001', client, {})

    // One call per iteration; iter 1 empty (attempt 0, not an exit),
    // iter 2 empty (attempt 1 => stall exit). 1 + 1 = 2.
    assert.equal(callCount, 2, 'claude-code: one call per iteration, and the loop retries a no-op once')
    assert.equal(run.status, 'rejected-empty-output')
    assert.equal(run.stoppedBecause, 'stalled')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Project harness feature: the kind:'harness' element's own coding path
// ---------------------------------------------------------------------------

const WEB_PLATFORM = {
  id: 'web' as const,
  label: 'Web App',
  entryPointHint: 'index.html + main.tsx',
  wiringHint: 'ES module imports',
  lifecycleHint: 'start only',
  builtIn: true,
}

function harnessProject(): Project {
  const p = baseProject()
  p.platform = 'web'
  p.architecture!.elements.push({
    id: 'ARCH-HARNESS',
    kind: 'harness',
    name: 'Harness',
    responsibility: 'Owns the entry point and wiring.',
    row: -2,
    col: 0,
    rowSpan: 1,
    colSpan: 1,
    interfaces: ['ARCH-001', 'ARCH-002'],
    elementInterfaces: [],
    harnessSpec: {
      derivedForPlatform: 'web',
      checklist: [{ key: 'entry-point', status: 'applies', realisation: 'index.html loads main.tsx' }],
      linkRealisations: [{ masterDefinitionId: 'IFACE-001', summary: 'Login UI constructed with an Auth Service ref' }],
      narrative: 'main.tsx builds Auth Service then Login UI and calls start().',
      derivedAt: new Date().toISOString(),
    },
  })
  return p
}

test('runCodingForElement (harness): blocked when no platform is selected', async () => {
  const dir = await tempProjectDir()
  try {
    const project = harnessProject()
    project.platform = undefined
    const client = { async runAgentTask() { throw new Error('should not run') } }
    const run = await runCodingForElement(project, dir, 'ARCH-HARNESS', client, {})
    assert.equal(run.status, 'rejected-not-eligible')
    assert.match(run.rawLog, /platform/i)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runCodingForElement (harness): blocked when harnessSpec platform mismatches project.platform', async () => {
  const dir = await tempProjectDir()
  try {
    const project = harnessProject()
    project.architecture!.elements.find((e) => e.kind === 'harness')!.harnessSpec!.derivedForPlatform = 'android'
    const client = { async runAgentTask() { throw new Error('should not run') } }
    const run = await runCodingForElement(project, dir, 'ARCH-HARNESS', client, { platform: WEB_PLATFORM })
    assert.equal(run.status, 'rejected-not-eligible')
    assert.match(run.rawLog, /Define Harness again/i)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runCodingForElement (harness): writes the entry file at the src root, commits, success', async () => {
  process.env.FAKE_CLAUDE_MODE = 'write-in-scope'
  process.env.FAKE_CLAUDE_WRITE_PATH = 'main.tsx'
  const dir = await tempProjectDir()
  try {
    const project = harnessProject()
    const client = new ClaudeCodeAgentClient()
    const run = await runCodingForElement(project, dir, 'ARCH-HARNESS', client, {
      binary: 'node',
      binaryArgs: [fixture],
      platform: WEB_PLATFORM,
    })
    assert.equal(run.status, 'success')
    assert.equal(run.allowedSubfolder, '_harness')
    assert.match(run.diff, /main\.tsx/)
    assert.ok(await exists(path.join(sourceTreeRoot(dir), 'main.tsx')))
    assert.ok(!run.warnings, 'a clean in-scope write produces no warnings')
  } finally {
    await rm(dir, { recursive: true, force: true })
    delete process.env.FAKE_CLAUDE_WRITE_PATH
  }
})

test('runCodingForElement (harness): a write into an element folder is reverted and flagged, run still succeeds if it also wrote the entry', async () => {
  process.env.FAKE_CLAUDE_MODE = 'write-in-scope'
  // Fixture writes exactly one path; point it at an element folder and
  // assert it never lands in the real tree and surfaces a warning.
  process.env.FAKE_CLAUDE_WRITE_PATH = 'login-ui/sneaky.txt'
  const dir = await tempProjectDir()
  try {
    const project = harnessProject()
    const client = new ClaudeCodeAgentClient()
    const run = await runCodingForElement(project, dir, 'ARCH-HARNESS', client, {
      binary: 'node',
      binaryArgs: [fixture],
      platform: WEB_PLATFORM,
    })
    // Nothing in-scope was written, so from the merge-back's view this is
    // an empty run — but the out-of-scope attempt must still be flagged.
    assert.ok(!(await exists(path.join(sourceTreeRoot(dir), 'login-ui', 'sneaky.txt'))))
    assert.ok(run.warnings && run.warnings.some((w) => /sneaky\.txt/.test(w)))
    assert.ok(run.warnings.some((w) => /missing (a )?requirement or interface/i.test(w)))
  } finally {
    await rm(dir, { recursive: true, force: true })
    delete process.env.FAKE_CLAUDE_WRITE_PATH
  }
})

// ---------------------------------------------------------------------------
// Harness prompt: the "Elements to instantiate and wire" block
// ---------------------------------------------------------------------------

// harnessProject() (above) has ARCH-001/ARCH-002 and a single IFACE-001 with
// NO declarations. This variant adds declarations across TWO interface
// definitions so ARCH-001 has two InterfaceElementDeclarations to merge.
function harnessProjectWithDeclarations(): Project {
  const p = harnessProject()
  const arch = p.architecture!
  arch.elements.push({
    id: 'ARCH-003', kind: 'service', name: 'Telemetry', responsibility: 'Records events',
    row: 0, col: 2, rowSpan: 1, colSpan: 1, interfaces: [], elementInterfaces: [],
  })
  arch.elements.find((e) => e.kind === 'harness')!.interfaces.push('ARCH-003')
  arch.interfaceDefinitions = [
    {
      id: 'IFACE-001', name: 'Login UI <-> Auth Service',
      participants: [{ elementId: 'ARCH-001', role: 'both' }, { elementId: 'ARCH-002', role: 'both' }],
      status: 'defined', updatedAt: new Date().toISOString(), operations: [],
      declarations: [
        { elementId: 'ARCH-001', does: 'Renders login', exposes: ['renderForm'], owns: ['formState'], visibleTo: ['ARCH-002'] },
        { elementId: 'ARCH-002', does: 'Authenticates', exposes: ['login'], owns: ['sessions'], visibleTo: ['none'] },
      ],
    },
    {
      id: 'IFACE-002', name: 'Login UI <-> Telemetry',
      participants: [{ elementId: 'ARCH-001', role: 'both' }, { elementId: 'ARCH-003', role: 'both' }],
      status: 'defined', updatedAt: new Date().toISOString(), operations: [],
      declarations: [
        { elementId: 'ARCH-001', does: 'Renders login', exposes: ['emitEvent'], owns: ['eventQueue'], visibleTo: ['ARCH-003'] },
        { elementId: 'ARCH-003', does: 'Records events', exposes: ['record'], owns: [], visibleTo: ['none'] },
      ],
    },
  ]
  return p
}

test('buildHarnessCodingPrompt: an element in two interface definitions gets ALL its exposes/owns merged, not just the first', () => {
  const project = harnessProjectWithDeclarations()
  const prompt = buildCodingPrompt(project, 'ARCH-HARNESS', '_harness', 'manual-recode', WEB_PLATFORM)
  // Both definitions' contributions for ARCH-001 must survive the merge.
  assert.match(prompt, /renderForm/)
  assert.match(prompt, /emitEvent/)
  assert.match(prompt, /formState/)
  assert.match(prompt, /eventQueue/)
})

test('buildHarnessCodingPrompt: surfaces owns and data-visibility, previously dropped entirely', () => {
  const project = harnessProjectWithDeclarations()
  const prompt = buildCodingPrompt(project, 'ARCH-HARNESS', '_harness', 'manual-recode', WEB_PLATFORM)
  // owns is a union across both definitions; visibleTo is last-writer-wins
  // (IFACE-002's ['ARCH-003'] over IFACE-001's ['ARCH-002']) per the
  // InterfaceElementDeclaration doc comment in types.ts.
  assert.match(prompt, /owns: [^\n]*formState/)
  assert.match(prompt, /owns: [^\n]*eventQueue/)
  assert.match(prompt, /data visible to: ARCH-003/)
})

test('buildHarnessCodingPrompt: test-file instruction carries the swTestInstruction hazards plus the node-vs-browser one', () => {
  const project = harnessProject()
  const prompt = buildCodingPrompt(project, 'ARCH-HARNESS', '_harness', 'manual-recode', WEB_PLATFORM)
  assert.match(prompt, /\.mjs/)
  assert.match(prompt, /silently skipped/i)
  assert.match(prompt, /do NOT append any non-code text/i)
  // The harness-only hazard: its test runs under node, the app is browser ESM.
  assert.match(prompt, /runs under `node`/)
  assert.match(prompt, /ReferenceError/)
})

// ---------------------------------------------------------------------------
// Harness prompt: the freshly-scanned element API manifest (Step 4)
// ---------------------------------------------------------------------------

const ELEMENT_APIS_FIXTURE = [
  {
    elementId: 'ARCH-001', folder: 'login-ui', entryFile: 'index.js', scanned: true,
    exports: [
      { name: 'createForm', kind: 'function' as const, params: 'rootEl, onSubmit' },
      { name: 'FormState', kind: 'class' as const, methods: ['constructor(initial)', 'reset()'] },
      { name: 'DEFAULT_TIMEOUT', kind: 'const' as const },
    ],
  },
  {
    elementId: 'ARCH-002', folder: 'auth-service', entryFile: 'index.js', scanned: true,
    exports: [{ name: 'login', kind: 'function' as const, params: 'username, password' }],
  },
]

test('buildHarnessCodingPrompt: inlines the scanned API as code: lines with real signatures', () => {
  const project = harnessProject()
  const prompt = buildCodingPrompt(
    project, 'ARCH-HARNESS', '_harness', 'manual-recode', WEB_PLATFORM, undefined, ELEMENT_APIS_FIXTURE,
  )
  assert.match(prompt, /code: \.\/login-ui\/index\.js/)
  assert.match(prompt, /function createForm\(rootEl, onSubmit\)/)
  assert.match(prompt, /class FormState \{ constructor\(initial\); reset\(\) \}/)
  assert.match(prompt, /const DEFAULT_TIMEOUT/)
  assert.match(prompt, /function login\(username, password\)/)
})

test('buildHarnessCodingPrompt: with a manifest, the old "READ every element\'s folder" invitation is gone', () => {
  const project = harnessProject()
  const withManifest = buildCodingPrompt(
    project, 'ARCH-HARNESS', '_harness', 'manual-recode', WEB_PLATFORM, undefined, ELEMENT_APIS_FIXTURE,
  )
  assert.ok(!/MAY READ every element's folder to see what it exports/.test(withManifest))
  assert.match(withManifest, /do NOT glob, list, or read element folders/i)
  // The duplicate pre-generated import list is gone too.
  assert.ok(!/import \{ \/\* \.\.\. \*\/ \}/.test(withManifest))
})

test('buildHarnessCodingPrompt: an element with no scanned code renders NOT YET WRITTEN and a provisional-wiring note', () => {
  const project = harnessProject()
  const apis = [
    { elementId: 'ARCH-001', folder: 'login-ui', entryFile: 'index.js', scanned: false, exports: [] },
    ELEMENT_APIS_FIXTURE[1],
  ]
  const prompt = buildCodingPrompt(
    project, 'ARCH-HARNESS', '_harness', 'manual-recode', WEB_PLATFORM, undefined, apis,
  )
  assert.match(prompt, /login-ui\/index\.js — NOT YET WRITTEN/)
  assert.match(prompt, /wiring is provisional/i)
})

test('buildHarnessCodingPrompt: uses the harness self-review variant, not the element one', () => {
  const project = harnessProject()
  const prompt = buildCodingPrompt(project, 'ARCH-HARNESS', '_harness', 'manual-recode', WEB_PLATFORM)
  assert.ok(!/reusing existing code already in this subfolder/.test(prompt))
  assert.match(prompt, /without re-reading your own files/)
})

test('buildHarnessCodingPrompt: a non-web platform lists no code: lines and keeps the read-the-folders wording', () => {
  const project = harnessProject()
  project.platform = 'cli'
  const CLI_PLATFORM = { id: 'cli' as const, label: 'CLI', builtIn: true, entryPointHint: 'main()', wiringHint: 'DI', lifecycleHint: 'start + SIGINT' }
  // scanElementApis on a non-web platform returns scanned:false / no entryFile.
  const apis = [
    { elementId: 'ARCH-001', folder: 'login-ui', entryFile: undefined, scanned: false, exports: [] },
    { elementId: 'ARCH-002', folder: 'auth-service', entryFile: undefined, scanned: false, exports: [] },
  ]
  const prompt = buildCodingPrompt(
    project, 'ARCH-HARNESS', '_harness', 'manual-recode', CLI_PLATFORM, undefined, apis,
  )
  assert.ok(!/code: /.test(prompt))
  assert.match(prompt, /no single mandated entry file per element/i)
  assert.match(prompt, /read each element's folder/i)
})
