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
    assert.equal(created.schemaVersion, 1)
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
