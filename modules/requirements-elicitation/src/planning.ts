import { buildPlanningChatMessages, buildPlanningStoryMessages, buildResearchMessages } from './planningPersona.js'
import type { LlmCallOptions, LlmClient, LlmUsage } from './LlmClient.js'
import type {
  ArchitectureElement,
  Backlog,
  Project,
  Research,
  Story,
  StorySequencingConflict,
  StorySequencingConflictKind,
} from './types.js'

function requireBacklog(project: Project): Backlog {
  if (!project.backlog) {
    project.backlog = { stories: [], nextStorySeq: 1 }
  }
  return project.backlog
}

function activeStories(backlog: Backlog): Story[] {
  return backlog.stories.filter((s) => !s.deletedAt)
}

export interface CreateStoryFields {
  title: string
  description: string
  architectureElementId?: string | null
  interfaceElementIds?: [string, string]
  requirementIds?: string[]
}

// Ids are permanent and sequential (STORY-NNN), same rationale as ARCH-NNN —
// never reused after deletion.
export function createStory(project: Project, fields: CreateStoryFields): Story {
  const backlog = requireBacklog(project)
  const seq = backlog.nextStorySeq
  const story: Story = {
    id: `STORY-${String(seq).padStart(3, '0')}`,
    title: fields.title,
    description: fields.description,
    architectureElementId: fields.architectureElementId ?? null,
    interfaceElementIds: fields.interfaceElementIds,
    requirementIds: fields.requirementIds ?? [],
    status: 'not-started',
    dependsOn: [],
    sequence: null,
    createdAt: new Date().toISOString(),
  }
  backlog.nextStorySeq = seq + 1
  backlog.stories.push(story)
  return story
}

export interface UpdateStoryFields {
  title?: string
  description?: string
  architectureElementId?: string | null
  requirementIds?: string[]
  status?: Story['status']
}

export function updateStory(project: Project, storyId: string, fields: UpdateStoryFields): Story {
  const backlog = requireBacklog(project)
  const story = backlog.stories.find((s) => s.id === storyId)
  if (!story) {
    throw new Error(`Story ${storyId} not found`)
  }
  Object.assign(story, fields)
  return story
}

// Soft-delete, mirrors deleteRequirement — also removes the deleted story
// from any other story's dependsOn list so nothing is left pointing at a
// dangling id.
export function deleteStory(project: Project, storyId: string): void {
  const backlog = requireBacklog(project)
  const story = backlog.stories.find((s) => s.id === storyId)
  if (!story) {
    throw new Error(`Story ${storyId} not found`)
  }
  story.deletedAt = new Date().toISOString()
  for (const other of backlog.stories) {
    other.dependsOn = other.dependsOn.filter((id) => id !== storyId)
  }
}

// Same push-if-absent semantics as acceptProposedInterface.
export function addStoryDependency(project: Project, storyId: string, dependsOnId: string): Story {
  const backlog = requireBacklog(project)
  const story = backlog.stories.find((s) => s.id === storyId)
  if (!story) {
    throw new Error(`Story ${storyId} not found`)
  }
  if (!backlog.stories.some((s) => s.id === dependsOnId)) {
    throw new Error(`Story ${dependsOnId} not found`)
  }
  if (storyId === dependsOnId) {
    throw new Error('A story cannot depend on itself')
  }
  if (!story.dependsOn.includes(dependsOnId)) story.dependsOn.push(dependsOnId)
  return story
}

export function removeStoryDependency(project: Project, storyId: string, dependsOnId: string): Story {
  const backlog = requireBacklog(project)
  const story = backlog.stories.find((s) => s.id === storyId)
  if (!story) {
    throw new Error(`Story ${storyId} not found`)
  }
  story.dependsOn = story.dependsOn.filter((id) => id !== dependsOnId)
  return story
}

const CIRCULAR_DEP_KIND: StorySequencingConflictKind = 'circular-dependency'

// Mechanical (non-LLM) cycle detection over the story dependsOn graph — same
// DFS shape as architecture.ts's detectCircularDependencies, walking
// dependsOn instead of interfaces.
export function detectCircularStoryDependencies(stories: Story[]): StorySequencingConflict[] {
  const byId = new Map(stories.map((s) => [s.id, s]))
  const conflicts: StorySequencingConflict[] = []
  const seenCycles = new Set<string>()

  function dfs(startId: string, currentId: string, visited: Set<string>, path: string[]): void {
    const current = byId.get(currentId)
    if (!current) return
    for (const nextId of current.dependsOn) {
      if (nextId === startId && path.length > 0) {
        const cycle = [...path, currentId, startId]
        const key = Array.from(new Set(cycle)).sort().join(',')
        if (!seenCycles.has(key)) {
          seenCycles.add(key)
          conflicts.push({
            id: '',
            kind: CIRCULAR_DEP_KIND,
            storyIds: Array.from(new Set(cycle)),
            rationale: `Circular dependency: ${cycle.join(' -> ')}`,
          })
        }
        continue
      }
      if (visited.has(nextId)) continue
      dfs(startId, nextId, new Set(visited).add(nextId), [...path, currentId])
    }
  }

  for (const story of stories) {
    dfs(story.id, story.id, new Set([story.id]), [])
  }
  return conflicts
}

// "Run Sequencing" (Area C, req 10b) — mechanical topological sort (Kahn's
// algorithm) over dependsOn, ties broken by createdAt ascending for
// determinism. Stories caught in a detected cycle are left with
// sequence: null (surfaced via detectCircularStoryDependencies instead) —
// this only detects and records, never auto-resolves, same rule as
// checkArchitectureConflicts.
export function sequenceStories(project: Project): Story[] {
  const backlog = requireBacklog(project)
  const stories = activeStories(backlog)
  const conflicts = detectCircularStoryDependencies(stories)
  backlog.conflicts = conflicts.map((c, i) => ({ ...c, id: `SEQCONF-${i + 1}` }))
  const cyclicIds = new Set(conflicts.flatMap((c) => c.storyIds))

  const remaining = new Map(stories.filter((s) => !cyclicIds.has(s.id)).map((s) => [s.id, s]))
  for (const story of stories) {
    if (cyclicIds.has(story.id)) story.sequence = null
  }

  let seq = 1
  while (remaining.size > 0) {
    const ready = Array.from(remaining.values())
      .filter((s) => s.dependsOn.every((depId) => !remaining.has(depId)))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    if (ready.length === 0) break // shouldn't happen once cyclic stories are excluded, but avoid an infinite loop
    for (const story of ready) {
      story.sequence = seq++
      remaining.delete(story.id)
    }
  }

  return stories
}

function addUsage(a: LlmUsage | undefined, b: LlmUsage | undefined): LlmUsage | undefined {
  if (!a) return b
  if (!b) return a
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  }
}

const STORY_LINE = /^STORY:\s*([^|]+)\|\s*([^|]+)\|\s*(.*)$/gm

export interface GenerateStoriesResult {
  stories: Story[]
  usage?: LlmUsage
}

// "Generate Stories" (Area C, req 10a) — one LLM call per architecture
// element, decomposing its allocated requirements into stories. Only
// requirement ids actually allocated to the target element are accepted,
// same defensive filtering as autoConfigureAndAllocate's ALLOCATE_LINE
// handling.
export async function generateStoriesForElement(
  project: Project,
  llmClient: LlmClient,
  architectureElementId: string,
  llmOptions?: LlmCallOptions,
): Promise<GenerateStoriesResult> {
  requireBacklog(project)
  if (!project.architecture) {
    throw new Error('Project has no architecture — select an Architecture type first')
  }
  const element = project.architecture.elements.find((e) => e.id === architectureElementId)
  if (!element) {
    throw new Error(`Architecture element ${architectureElementId} not found`)
  }
  const allocated = project.requirements.filter(
    (r) => !r.deletedAt && r.architectureElements.includes(architectureElementId),
  )
  const allocatedIds = new Set(allocated.map((r) => r.id))

  const messages = buildPlanningStoryMessages(element, allocated)
  const result = await llmClient.chat(messages, llmOptions)

  if (result.content.trim() === 'NONE') {
    return { stories: [], usage: result.usage }
  }

  const created: Story[] = []
  for (const m of result.content.matchAll(STORY_LINE)) {
    const title = m[1].trim()
    const description = m[2].trim()
    const requirementIds = m[3]
      .split(',')
      .map((id) => id.trim())
      .filter((id) => allocatedIds.has(id))
    const story = createStory(project, {
      title,
      description,
      architectureElementId,
      requirementIds,
    })
    created.push(story)
  }
  return { stories: created, usage: result.usage }
}

export interface GenerateAllStoriesResult {
  stories: Story[]
  usage?: LlmUsage
}

// Non-destructive re-run: only tops up elements with zero non-deleted
// stories yet, same "topping up gaps" pattern as autoConfigureAndAllocate.
export async function generateStoriesForAllUnplannedElements(
  project: Project,
  llmClient: LlmClient,
  llmOptions?: LlmCallOptions,
): Promise<GenerateAllStoriesResult> {
  if (!project.architecture) {
    throw new Error('Project has no architecture — select an Architecture type first')
  }
  const backlog = requireBacklog(project)
  const plannedElementIds = new Set(
    activeStories(backlog)
      .map((s) => s.architectureElementId)
      .filter((id): id is string => id !== null),
  )
  const unplanned = project.architecture.elements.filter((e: ArchitectureElement) => !plannedElementIds.has(e.id))

  const allCreated: Story[] = []
  let usage: LlmUsage | undefined
  for (const element of unplanned) {
    const result = await generateStoriesForElement(project, llmClient, element.id, llmOptions)
    allCreated.push(...result.stories)
    usage = addUsage(usage, result.usage)
  }
  return { stories: allCreated, usage }
}

const OPTION_LINE = /^OPTION:\s*([^|]+)\|\s*(.+)$/gm
const RECOMMEND_LINE = /^RECOMMEND:\s*([^|]+)\|\s*(.+)$/gm

export interface ResearchStoryResult {
  research: Research | null
  usage?: LlmUsage
}

// Research-before-planning (Area C, resolved) — conditional: persists
// story.research only when the LLM found genuinely multiple viable
// approaches; a "NONE" reply leaves story.research unset rather than
// fabricating a single-option research record.
export async function researchStory(
  project: Project,
  llmClient: LlmClient,
  storyId: string,
  llmOptions?: LlmCallOptions,
): Promise<ResearchStoryResult> {
  const backlog = requireBacklog(project)
  const story = backlog.stories.find((s) => s.id === storyId)
  if (!story) {
    throw new Error(`Story ${storyId} not found`)
  }
  if (!project.architecture || !story.architectureElementId) {
    throw new Error('Story has no architecture element to research against')
  }
  const element = project.architecture.elements.find((e) => e.id === story.architectureElementId)
  if (!element) {
    throw new Error(`Architecture element ${story.architectureElementId} not found`)
  }

  const messages = buildResearchMessages(element, story.title, story.description)
  const result = await llmClient.chat(messages, llmOptions)

  if (result.content.trim() === 'NONE') {
    return { research: null, usage: result.usage }
  }

  const options = Array.from(result.content.matchAll(OPTION_LINE), (m) => ({
    name: m[1].trim(),
    tradeoffs: m[2].trim(),
  }))
  const recommendMatch = Array.from(result.content.matchAll(RECOMMEND_LINE))[0]
  if (options.length === 0 || !recommendMatch) {
    return { research: null, usage: result.usage }
  }

  const research: Research = {
    options,
    recommendation: recommendMatch[1].trim(),
    rationale: recommendMatch[2].trim(),
    researchedAt: new Date().toISOString(),
  }
  story.research = research
  return { research, usage: result.usage }
}

// Chat-proposed stories name their target architecture element (chat can
// range across the whole backlog, unlike generateStoriesForElement's
// single-element scope) — a distinct line grammar from planning.ts's
// STORY_LINE (title|description|reqIds), never mixed with it.
const CHAT_STORY_LINE = /^STORY:\s*([^|]+)\|\s*([^|]+)\|\s*(.+)$/gm

export interface ProposedStory {
  architectureElementName: string
  title: string
  description: string
}

function extractProposedStories(reply: string): ProposedStory[] {
  return Array.from(reply.matchAll(CHAT_STORY_LINE), (m) => ({
    architectureElementName: m[1].trim(),
    title: m[2].trim(),
    description: m[3].trim(),
  }))
}

export interface ChatWithPMResult {
  reply: string
  proposedStories: ProposedStory[]
  usage?: LlmUsage
}

// PM-chat path (mirrors chatWithAnalyst/chatWithArchitect) — does not save
// anything. Proposed stories are returned for the human to accept or
// discard; the caller resolves architectureElementName to a real element id
// and invokes createStory for each accepted proposal, keeping
// "resolution is always human" intact.
export async function chatWithPM(
  project: Project,
  llmClient: LlmClient,
  userMessage: string,
  llmOptions?: LlmCallOptions,
): Promise<ChatWithPMResult> {
  const backlog = requireBacklog(project)
  const elements = project.architecture?.elements ?? []
  const messages = buildPlanningChatMessages(elements, backlog, userMessage)
  const result = await llmClient.chat(messages, llmOptions)
  return {
    reply: result.content,
    proposedStories: extractProposedStories(result.content),
    usage: result.usage,
  }
}
