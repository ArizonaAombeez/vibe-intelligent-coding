import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { ProjectStore } from '../src/index.js'

async function withTempStore(fn: (store: ProjectStore, projectsRoot: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vic-req-elicitation-test-'))
  try {
    const store = new ProjectStore({ projectsRoot: dir })
    await fn(store, dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('createProject then loadProject round-trips with schemaVersion', async () => {
  await withTempStore(async (store) => {
    const created = await store.createProject('My Project')
    assert.equal(created.name, 'My Project')
    assert.equal(created.schemaVersion, 3)
    assert.equal(created.projectMode, 'new')
    assert.equal(created.requirements.length, 0)

    const loaded = await store.loadProject(created.id)
    assert.deepEqual(loaded, created)
  })
})

test('createProject accepts an explicit "import" mode', async () => {
  await withTempStore(async (store) => {
    const created = await store.createProject('Legacy App', 'import')
    assert.equal(created.projectMode, 'import')

    const loaded = await store.loadProject(created.id)
    assert.equal(loaded.projectMode, 'import')
  })
})

test('saveProject persists requirement changes', async () => {
  await withTempStore(async (store) => {
    const project = await store.createProject('Proj')
    project.requirements.push({
      id: 'REQ-001',
      text: 'The system shall do a thing',
      type: null,
      status: 'elicited',
      createdAt: new Date().toISOString(),
      provenance: 'human',
      architectureElements: [],
    })
    await store.saveProject(project)

    const reloaded = await store.loadProject(project.id)
    assert.equal(reloaded.requirements.length, 1)
    assert.equal(reloaded.requirements[0].id, 'REQ-001')
  })
})

test('listProjects returns all created projects', async () => {
  await withTempStore(async (store) => {
    await store.createProject('A')
    await store.createProject('B')

    const projects = await store.listProjects()
    assert.equal(projects.length, 2)
    assert.deepEqual(
      projects.map((p) => p.name).sort(),
      ['A', 'B'],
    )
  })
})

test('listProjects returns empty array when the projects root does not exist yet', async () => {
  const dir = path.join(os.tmpdir(), 'vic-req-elicitation-nonexistent-' + Date.now())
  const store = new ProjectStore({ projectsRoot: dir })
  const projects = await store.listProjects()
  assert.deepEqual(projects, [])
})

test('loadProject defaults projectMode and requirement provenance for pre-existing saved projects', async () => {
  await withTempStore(async (store, projectsRoot) => {
    const projectId = 'legacy-mode-proj'
    const dir = path.join(projectsRoot, projectId)
    const legacyProject = {
      schemaVersion: 1,
      id: projectId,
      name: 'Legacy',
      nextRequirementSeq: 2,
      requirements: [
        {
          id: 'REQ-001',
          text: 'The system shall do a thing',
          type: null,
          status: 'elicited',
          createdAt: new Date().toISOString(),
        },
      ],
    }
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'project.json'), JSON.stringify(legacyProject), 'utf-8')

    const loaded = await store.loadProject(projectId)
    assert.equal(loaded.projectMode, 'new')
    assert.equal(loaded.requirements[0].provenance, 'human')
  })
})

test('loadProject drops legacy string[] conflicts on load instead of crashing', async () => {
  await withTempStore(async (store, projectsRoot) => {
    const projectId = 'legacy-proj'
    const dir = path.join(projectsRoot, projectId)
    // Writes the on-disk layout store.ts itself uses (projectDir/project.json)
    // directly, with a project.json in the pre-migration conflicts shape
    // (bare requirement-id strings, no rationale) that real saved projects
    // had before RequirementConflict existed.
    const legacyProject = {
      schemaVersion: 1,
      id: projectId,
      name: 'Legacy',
      nextRequirementSeq: 2,
      requirements: [
        {
          id: 'REQ-001',
          text: 'The system shall do a thing',
          type: null,
          status: 'elicited',
          createdAt: new Date().toISOString(),
          conflicts: ['REQ-002'],
        },
      ],
    }
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'project.json'), JSON.stringify(legacyProject), 'utf-8')

    const loaded = await store.loadProject(projectId)
    assert.equal(loaded.requirements[0].conflicts, undefined)
    assert.equal(loaded.requirements[0].conflictsCheckedAt, undefined)
  })
})

test('loadProject migrates legacy scalar architectureElement to the architectureElements array on load', async () => {
  await withTempStore(async (store, projectsRoot) => {
    const projectId = 'legacy-arch-element-proj'
    const dir = path.join(projectsRoot, projectId)
    // Pre-migration on-disk shape (element-based Coding migration,
    // hide-not-delete): a single nullable string field, not an array.
    const legacyProject = {
      schemaVersion: 1,
      id: projectId,
      name: 'Legacy',
      projectMode: 'new',
      requirements: [
        {
          id: 'REQ-001',
          text: 'Allocated to one element',
          type: null,
          status: 'allocated',
          createdAt: new Date().toISOString(),
          provenance: 'human',
          architectureElement: 'ARCH-001',
        },
        {
          id: 'REQ-002',
          text: 'Never allocated',
          type: null,
          status: 'elicited',
          createdAt: new Date().toISOString(),
          provenance: 'human',
          architectureElement: null,
        },
      ],
    }
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'project.json'), JSON.stringify(legacyProject), 'utf-8')

    const loaded = await store.loadProject(projectId)
    assert.deepEqual(loaded.requirements[0].architectureElements, ['ARCH-001'])
    assert.deepEqual(loaded.requirements[1].architectureElements, [])
    // Legacy field is removed, not left dangling alongside the new one.
    assert.equal('architectureElement' in loaded.requirements[0], false)
  })
})

test('loadProject (migrate v3) prunes interface refs to elements that no longer exist — the Worm 2 orphan state', async () => {
  await withTempStore(async (store, projectsRoot) => {
    const projectId = 'worm-2-orphans'
    const dir = path.join(projectsRoot, projectId)
    // ARCH-005 survives; ARCH-002/007 were deleted but their interface
    // definitions and ARCH-005's local copies were left behind.
    const stale = {
      schemaVersion: 2,
      id: projectId,
      name: 'Worm 2',
      projectMode: 'new',
      requirements: [],
      architecture: {
        layers: ['Core'],
        elements: [
          {
            id: 'ARCH-005',
            kind: 'functional',
            name: 'Game Engine',
            responsibility: 'Runs the loop',
            row: 0,
            col: 0,
            rowSpan: 1,
            colSpan: 1,
            interfaces: ['ARCH-002', 'ARCH-003'],
            elementInterfaces: [
              { masterDefinitionId: 'IFACE-001', role: 'both', aligned: true, operations: [] },
              { masterDefinitionId: 'IFACE-004', role: 'both', aligned: true, operations: [] },
            ],
          },
          {
            id: 'ARCH-003',
            kind: 'functional',
            name: 'Game Renderer',
            responsibility: 'Draws frames',
            row: 0,
            col: 1,
            rowSpan: 1,
            colSpan: 1,
            interfaces: ['ARCH-005'],
            elementInterfaces: [
              { masterDefinitionId: 'IFACE-004', role: 'both', aligned: true, operations: [] },
            ],
          },
        ],
        nextElementSeq: 6,
        nextInterfaceSeq: 7,
        interfaceDefinitions: [
          {
            id: 'IFACE-001',
            name: 'HTML Portal ↔ Game Engine',
            participants: [
              { elementId: 'ARCH-002', role: 'both' },
              { elementId: 'ARCH-005', role: 'both' },
            ],
            status: 'defined',
            updatedAt: new Date().toISOString(),
            operations: [],
          },
          {
            id: 'IFACE-004',
            name: 'Game Engine ↔ Game Renderer',
            participants: [
              { elementId: 'ARCH-005', role: 'both' },
              { elementId: 'ARCH-003', role: 'both' },
            ],
            status: 'defined',
            updatedAt: new Date().toISOString(),
            operations: [
              { name: 'renderFrame', description: 'draw', request: 'state', response: 'ack', errors: 'none' },
            ],
          },
        ],
      },
    }
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'project.json'), JSON.stringify(stale), 'utf-8')

    const loaded = await store.loadProject(projectId)
    assert.equal(loaded.schemaVersion, 3)

    // IFACE-001 named the deleted ARCH-002 -> gone. IFACE-004 is between two
    // live elements -> kept.
    const defIds = (loaded.architecture!.interfaceDefinitions ?? []).map((d) => d.id)
    assert.deepEqual(defIds, ['IFACE-004'])

    // ARCH-005 loses its IFACE-001 copy and its dead ARCH-002 graph edge,
    // keeps the IFACE-004 copy and the ARCH-003 edge.
    const engine = loaded.architecture!.elements.find((e) => e.id === 'ARCH-005')!
    assert.deepEqual(
      engine.elementInterfaces.map((ei) => ei.masterDefinitionId),
      ['IFACE-004'],
    )
    assert.deepEqual(engine.interfaces, ['ARCH-003'])
  })
})
