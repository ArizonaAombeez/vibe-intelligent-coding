import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ClaudeCodeAgentClient } from 'vic-llm-claude-code'
import type { Project } from 'vic-requirements-elicitation'
import { runCodingForElement, sourceTreeRoot, interfaceChangedSinceLastCoding } from '../src/index.js'

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
  }
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

// GLM/OpenCode-specific retry (see runCoding.ts's runOnce/retry comment):
// GLM-5.x has a documented bug where a streamed tool-call response can drop
// its tool-call deltas mid-stream, producing a clean exit with nothing ever
// written — indistinguishable, from runCodingForElement's perspective, from
// any other empty-output run except for providerId. This exercises that
// retry path directly against a stub CodingAgentClient (not the real
// fake-claude-agent.mjs fixture, which always reports providerId
// 'claude-code') so the empty-then-success sequence and the providerId gate
// can both be controlled precisely.
test('runCodingForElement: an opencode run that writes nothing is retried once, and a write on the retry succeeds', async () => {
  const dir = await tempProjectDir()
  try {
    const project = baseProject()
    let callCount = 0
    const client = {
      async runAgentTask(_prompt: string, runOptions: { cwd: string }) {
        callCount++
        if (callCount === 1) {
          // First attempt: CLI "succeeds" (exit 0) but writes nothing —
          // the exact shape GLM's dropped-tool-call-delta bug produces.
          return { rawLog: 'first attempt: no tool calls landed', exitCode: 0, providerId: 'opencode' as const, timing: { msTotal: 10 } }
        }
        // Retry: writes the element's file for real.
        const { writeFile } = await import('node:fs/promises')
        await writeFile(path.join(runOptions.cwd, 'index.html'), '<html></html>', 'utf8')
        return { rawLog: 'retry: wrote index.html', exitCode: 0, providerId: 'opencode' as const, timing: { msTotal: 10 } }
      },
    }

    const run = await runCodingForElement(project, dir, 'ARCH-001', client, {})

    assert.equal(callCount, 2, 'the agent should be invoked exactly twice: the empty first attempt, then one retry')
    assert.equal(run.status, 'success')
    assert.equal(run.providerId, 'opencode')
    assert.ok(await exists(path.join(sourceTreeRoot(dir), 'login-ui', 'index.html')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runCodingForElement: an opencode run that writes nothing on both attempts is rejected-empty-output after exactly one retry', async () => {
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

    assert.equal(callCount, 2, 'a second empty attempt should not trigger a further retry — one retry only')
    assert.equal(run.status, 'rejected-empty-output')
    assert.equal(run.diff, '')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// Confirms the retry is genuinely GLM/opencode-scoped, not a general
// empty-output retry that would double the CLI cost for every provider —
// Claude Code hasn't shown this failure pattern, so it keeps its existing
// single-attempt behavior.
test('runCodingForElement: a claude-code run that writes nothing is NOT retried', async () => {
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

    assert.equal(callCount, 1, 'claude-code empty-output runs should not be retried')
    assert.equal(run.status, 'rejected-empty-output')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
