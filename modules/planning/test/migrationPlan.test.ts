import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateMigrationPlan } from '../src/index.js'
import { setArchitectureType, createArchitectureElement } from 'vic-requirements-elicitation'
import type { AlignmentStatus, CodeAlignmentMapping, Project } from 'vic-requirements-elicitation'

function importProjectWithArchitecture(): Project {
  const project: Project = {
    schemaVersion: 1,
    id: 'proj-1',
    name: 'Test Project',
    projectMode: 'import',
    requirements: [],
  }
  setArchitectureType(project, 'web-app')
  return project
}

function mapping(filePath: string, architectureElementId: string, status: AlignmentStatus): CodeAlignmentMapping {
  return { filePath, architectureElementId, status, rationale: 'test rationale' }
}

const CASES: Array<[AlignmentStatus, 'reuse-as-is' | 'refactor-in-place' | 'rewrite']> = [
  ['aligned', 'reuse-as-is'],
  ['partially-aligned', 'refactor-in-place'],
  ['no-equivalent', 'rewrite'],
]

for (const [status, expectedAction] of CASES) {
  test(`generateMigrationPlan maps alignment status "${status}" to action "${expectedAction}"`, () => {
    const project = importProjectWithArchitecture()
    const element = createArchitectureElement(project, {
      kind: 'functional',
      name: 'Login UI',
      responsibility: 'Renders the login form',
      row: 0,
      col: 0,
    })
    project.codeAlignment = {
      mappings: [mapping('src/login.ts', element.id, status)],
      checkedAt: new Date().toISOString(),
    }

    const stories = generateMigrationPlan(project)

    assert.equal(stories.length, 1)
    assert.equal(stories[0].architectureElementId, element.id)
    assert.equal(stories[0].action, expectedAction)
  })
}

test('generateMigrationPlan produces one story per architecture element, including elements with no mapped code', () => {
  const project = importProjectWithArchitecture()
  const withCode = createArchitectureElement(project, {
    kind: 'functional',
    name: 'Login UI',
    responsibility: 'Renders the login form',
    row: 0,
    col: 0,
  })
  const withoutCode = createArchitectureElement(project, {
    kind: 'service',
    name: 'Notifications',
    responsibility: 'Sends push notifications',
    row: 1,
    col: 0,
  })
  project.codeAlignment = {
    mappings: [mapping('src/login.ts', withCode.id, 'aligned')],
    checkedAt: new Date().toISOString(),
  }

  const stories = generateMigrationPlan(project)

  assert.equal(stories.length, 2)
  const notificationsStory = stories.find((s) => s.architectureElementId === withoutCode.id)
  assert.equal(notificationsStory?.action, 'rewrite')
})

test('generateMigrationPlan takes the worst status when multiple files map to one element', () => {
  const project = importProjectWithArchitecture()
  const element = createArchitectureElement(project, {
    kind: 'functional',
    name: 'Login UI',
    responsibility: 'Renders the login form',
    row: 0,
    col: 0,
  })
  project.codeAlignment = {
    mappings: [
      mapping('src/a.ts', element.id, 'aligned'),
      mapping('src/b.ts', element.id, 'no-equivalent'),
    ],
    checkedAt: new Date().toISOString(),
  }

  const stories = generateMigrationPlan(project)

  assert.equal(stories[0].action, 'rewrite')
})

test('generateMigrationPlan throws for a "new" mode project', () => {
  const project = importProjectWithArchitecture()
  project.projectMode = 'new'
  project.codeAlignment = { mappings: [], checkedAt: new Date().toISOString() }
  assert.throws(() => generateMigrationPlan(project), /import/i)
})

test('generateMigrationPlan throws when no architecture exists yet', () => {
  const project: Project = {
    schemaVersion: 1,
    id: 'proj-1',
    name: 'Test Project',
    projectMode: 'import',
    requirements: [],
  }
  project.codeAlignment = { mappings: [], checkedAt: new Date().toISOString() }
  assert.throws(() => generateMigrationPlan(project), /architecture/i)
})

test('generateMigrationPlan throws when no code alignment analysis has run yet', () => {
  const project = importProjectWithArchitecture()
  assert.throws(() => generateMigrationPlan(project), /alignment/i)
})
