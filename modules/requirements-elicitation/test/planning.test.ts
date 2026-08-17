import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  setArchitectureType,
  createArchitectureElement,
  createRequirementFromForm as createRequirementFromFormReal,
  reassignArchitectureElement,
  createStory,
  updateStory,
  deleteStory,
  addStoryDependency,
  removeStoryDependency,
  detectCircularStoryDependencies,
  sequenceStories,
  generateStoriesForElement,
  generateStoriesForAllUnplannedElements,
  researchStory,
} from '../src/index.js'
import type {
  LlmCallOptions,
  LlmChatResult,
  LlmClient,
  LlmMessage,
  Project,
  CreateRequirementFields,
  Story,
} from '../src/index.js'

function emptyProject(): Project {
  return {
    schemaVersion: 1,
    id: 'proj-1',
    name: 'Test Project',
    projectMode: 'new',
    requirements: [],
  }
}

const seqByProject = new WeakMap<Project, number>()
function createRequirementFromForm(project: Project, fields: CreateRequirementFields) {
  const seq = seqByProject.get(project) ?? 1
  seqByProject.set(project, seq + 1)
  return createRequirementFromFormReal(project, fields, seq)
}

class FakeLlmClient implements LlmClient {
  public receivedMessages: LlmMessage[][] = []
  public receivedOptions: (LlmCallOptions | undefined)[] = []
  constructor(private readonly reply: string) {}

  async chat(messages: LlmMessage[], options?: LlmCallOptions): Promise<LlmChatResult> {
    this.receivedMessages.push(messages)
    this.receivedOptions.push(options)
    return { content: this.reply }
  }
}

test('createStory assigns sequential STORY-NNN ids and defaults', () => {
  const project = emptyProject()
  const s1 = createStory(project, { title: 'A', description: 'Do A' })
  const s2 = createStory(project, { title: 'B', description: 'Do B' })

  assert.equal(s1.id, 'STORY-001')
  assert.equal(s2.id, 'STORY-002')
  assert.equal(s1.status, 'not-started')
  assert.deepEqual(s1.dependsOn, [])
  assert.equal(s1.sequence, null)
  assert.deepEqual(s1.requirementIds, [])
})

test('updateStory edits fields in place, leaving unspecified fields unchanged', () => {
  const project = emptyProject()
  const story = createStory(project, { title: 'A', description: 'Do A' })

  const updated = updateStory(project, story.id, { title: 'A revised', status: 'in-progress' })

  assert.equal(updated.title, 'A revised')
  assert.equal(updated.status, 'in-progress')
  assert.equal(updated.description, 'Do A')
})

test('updateStory throws for an unknown story id', () => {
  const project = emptyProject()
  createStory(project, { title: 'A', description: 'Do A' })
  assert.throws(() => updateStory(project, 'STORY-999', { title: 'x' }), /STORY-999/)
})

test('deleteStory soft-deletes and clears dangling dependency references', () => {
  const project = emptyProject()
  const a = createStory(project, { title: 'A', description: 'Do A' })
  const b = createStory(project, { title: 'B', description: 'Do B' })
  addStoryDependency(project, b.id, a.id)

  deleteStory(project, a.id)

  assert.ok(project.backlog?.stories.find((s) => s.id === a.id)?.deletedAt)
  assert.deepEqual(project.backlog?.stories.find((s) => s.id === b.id)?.dependsOn, [])
})

test('addStoryDependency pushes if absent and rejects self-dependency', () => {
  const project = emptyProject()
  const a = createStory(project, { title: 'A', description: 'Do A' })
  const b = createStory(project, { title: 'B', description: 'Do B' })

  addStoryDependency(project, b.id, a.id)
  addStoryDependency(project, b.id, a.id) // idempotent, no duplicate

  assert.deepEqual(project.backlog?.stories.find((s) => s.id === b.id)?.dependsOn, [a.id])
  assert.throws(() => addStoryDependency(project, a.id, a.id), /itself/)
})

test('removeStoryDependency filters out the given id', () => {
  const project = emptyProject()
  const a = createStory(project, { title: 'A', description: 'Do A' })
  const b = createStory(project, { title: 'B', description: 'Do B' })
  addStoryDependency(project, b.id, a.id)

  removeStoryDependency(project, b.id, a.id)

  assert.deepEqual(project.backlog?.stories.find((s) => s.id === b.id)?.dependsOn, [])
})

test('detectCircularStoryDependencies finds a 2-story cycle', () => {
  const project = emptyProject()
  const a = createStory(project, { title: 'A', description: 'Do A' })
  const b = createStory(project, { title: 'B', description: 'Do B' })
  addStoryDependency(project, a.id, b.id)
  addStoryDependency(project, b.id, a.id)

  const conflicts = detectCircularStoryDependencies(project.backlog!.stories)

  assert.equal(conflicts.length, 1)
  assert.deepEqual(new Set(conflicts[0].storyIds), new Set([a.id, b.id]))
})

test('detectCircularStoryDependencies finds a 3-story cycle', () => {
  const project = emptyProject()
  const a = createStory(project, { title: 'A', description: 'Do A' })
  const b = createStory(project, { title: 'B', description: 'Do B' })
  const c = createStory(project, { title: 'C', description: 'Do C' })
  addStoryDependency(project, a.id, b.id)
  addStoryDependency(project, b.id, c.id)
  addStoryDependency(project, c.id, a.id)

  const conflicts = detectCircularStoryDependencies(project.backlog!.stories)

  assert.equal(conflicts.length, 1)
  assert.deepEqual(new Set(conflicts[0].storyIds), new Set([a.id, b.id, c.id]))
})

test('detectCircularStoryDependencies returns nothing for a linear chain', () => {
  const project = emptyProject()
  const a = createStory(project, { title: 'A', description: 'Do A' })
  const b = createStory(project, { title: 'B', description: 'Do B' })
  addStoryDependency(project, b.id, a.id)

  assert.deepEqual(detectCircularStoryDependencies(project.backlog!.stories), [])
})

test('sequenceStories assigns increasing sequence numbers respecting a linear chain', () => {
  const project = emptyProject()
  const a = createStory(project, { title: 'A', description: 'Do A' })
  const b = createStory(project, { title: 'B', description: 'Do B' })
  const c = createStory(project, { title: 'C', description: 'Do C' })
  addStoryDependency(project, b.id, a.id)
  addStoryDependency(project, c.id, b.id)

  sequenceStories(project)

  const byId = (id: string) => project.backlog!.stories.find((s) => s.id === id) as Story
  assert.ok(byId(a.id).sequence! < byId(b.id).sequence!)
  assert.ok(byId(b.id).sequence! < byId(c.id).sequence!)
})

test('sequenceStories handles a diamond dependency (two branches converging)', () => {
  const project = emptyProject()
  const a = createStory(project, { title: 'A', description: 'Do A' })
  const b = createStory(project, { title: 'B', description: 'Do B' })
  const c = createStory(project, { title: 'C', description: 'Do C' })
  const d = createStory(project, { title: 'D', description: 'Do D' })
  addStoryDependency(project, b.id, a.id)
  addStoryDependency(project, c.id, a.id)
  addStoryDependency(project, d.id, b.id)
  addStoryDependency(project, d.id, c.id)

  sequenceStories(project)

  const byId = (id: string) => project.backlog!.stories.find((s) => s.id === id) as Story
  assert.ok(byId(a.id).sequence! < byId(b.id).sequence!)
  assert.ok(byId(a.id).sequence! < byId(c.id).sequence!)
  assert.ok(byId(b.id).sequence! < byId(d.id).sequence!)
  assert.ok(byId(c.id).sequence! < byId(d.id).sequence!)
})

test('sequenceStories leaves a cyclic pair unsequenced and records the conflict', () => {
  const project = emptyProject()
  const a = createStory(project, { title: 'A', description: 'Do A' })
  const b = createStory(project, { title: 'B', description: 'Do B' })
  const c = createStory(project, { title: 'C', description: 'Do C' })
  addStoryDependency(project, a.id, b.id)
  addStoryDependency(project, b.id, a.id)

  sequenceStories(project)

  const byId = (id: string) => project.backlog!.stories.find((s) => s.id === id) as Story
  assert.equal(byId(a.id).sequence, null)
  assert.equal(byId(b.id).sequence, null)
  assert.equal(byId(c.id).sequence, 1, 'the non-cyclic story still gets sequenced')
  assert.equal(project.backlog?.conflicts?.length, 1)
})

test('generateStoriesForElement parses STORY lines and only accepts requirement ids actually allocated to the element', async () => {
  const project = emptyProject()
  setArchitectureType(project, 'custom')
  const element = createArchitectureElement(project, {
    kind: 'functional',
    name: 'Login',
    responsibility: 'Handles login',
    row: 0,
    col: 0,
  })
  const r1 = createRequirementFromForm(project, { text: 'The system shall render a login form' })
  const other = createRequirementFromForm(project, { text: 'Unrelated requirement' })
  reassignArchitectureElement(project, r1.id, element.id)

  const fake = new FakeLlmClient(`STORY: Build login form|Render and validate the form|${r1.id},${other.id}`)
  const result = await generateStoriesForElement(project, fake, element.id)

  assert.equal(result.stories.length, 1)
  assert.equal(result.stories[0].architectureElementId, element.id)
  assert.deepEqual(result.stories[0].requirementIds, [r1.id], 'requirement not allocated to this element must be filtered out')
})

test('generateStoriesForElement returns no stories for a NONE reply', async () => {
  const project = emptyProject()
  setArchitectureType(project, 'custom')
  const element = createArchitectureElement(project, {
    kind: 'functional',
    name: 'Login',
    responsibility: 'Handles login',
    row: 0,
    col: 0,
  })

  const fake = new FakeLlmClient('NONE')
  const result = await generateStoriesForElement(project, fake, element.id)

  assert.deepEqual(result.stories, [])
})

test('generateStoriesForAllUnplannedElements only tops up elements with zero stories yet', async () => {
  const project = emptyProject()
  setArchitectureType(project, 'custom')
  const planned = createArchitectureElement(project, {
    kind: 'functional',
    name: 'Planned',
    responsibility: 'Already has a story',
    row: 0,
    col: 0,
  })
  const unplanned = createArchitectureElement(project, {
    kind: 'functional',
    name: 'Unplanned',
    responsibility: 'Needs stories',
    row: 0,
    col: 1,
  })
  createStory(project, { title: 'Existing', description: 'Already planned', architectureElementId: planned.id })

  const fake = new FakeLlmClient('STORY: New story|Description here|')
  const result = await generateStoriesForAllUnplannedElements(project, fake)

  assert.equal(result.stories.length, 1)
  assert.equal(result.stories[0].architectureElementId, unplanned.id)
  assert.equal(fake.receivedMessages.length, 1, 'only one LLM call, for the unplanned element')
})

test('researchStory parses OPTION/RECOMMEND lines and persists onto the story', async () => {
  const project = emptyProject()
  setArchitectureType(project, 'custom')
  const element = createArchitectureElement(project, {
    kind: 'functional',
    name: 'Auth',
    responsibility: 'Handles authentication',
    row: 0,
    col: 0,
  })
  const story = createStory(project, {
    title: 'Pick an auth library',
    description: 'Evaluate options',
    architectureElementId: element.id,
  })

  const fake = new FakeLlmClient(
    'OPTION: Passport|Widely used, more boilerplate\n' +
      'OPTION: Lucia|Lighter weight, newer\n' +
      'RECOMMEND: Lucia|Simpler API for this scale',
  )
  const result = await researchStory(project, fake, story.id)

  assert.equal(result.research?.options.length, 2)
  assert.equal(result.research?.recommendation, 'Lucia')
  assert.equal(story.research?.recommendation, 'Lucia')
})

test('researchStory leaves story.research unset on a NONE reply', async () => {
  const project = emptyProject()
  setArchitectureType(project, 'custom')
  const element = createArchitectureElement(project, {
    kind: 'functional',
    name: 'Auth',
    responsibility: 'Handles authentication',
    row: 0,
    col: 0,
  })
  const story = createStory(project, {
    title: 'Simple task',
    description: 'Only one reasonable approach',
    architectureElementId: element.id,
  })

  const fake = new FakeLlmClient('NONE')
  const result = await researchStory(project, fake, story.id)

  assert.equal(result.research, null)
  assert.equal(story.research, undefined)
})
