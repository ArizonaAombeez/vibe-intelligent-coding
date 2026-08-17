import type { LlmMessage } from './LlmClient.js'
import type { ArchitectureElement, Backlog, Requirement, Story } from './types.js'

// Generate Stories (Area C, req 10a: task decomposition scoped at
// architecture-element level) — one call per element, asking the PM to
// decompose its allocated requirements into stories. Mirrors architecture.ts's
// MODULE/ALLOCATE line-grammar convention: a fixed line format the caller
// regex-parses, never JSON.
export const STORY_DECOMPOSITION_SYSTEM_PROMPT = `You are the PM, responsible for the Planning stage of a software project.
Given one architecture element and the requirements allocated to it, break
the work into a small number of concrete, implementable stories.

Reply using exactly this line format, one per line, nothing else:

STORY: <short title>|<one or two sentence description>|<REQ-NNN>[,<REQ-NNN>...]
  The requirement id list is every requirement (from those given to you)
  this story covers — a story may cover more than one requirement if they
  are naturally implemented together, but do not invent requirement ids
  that weren't given to you.

Aim for stories that are independently implementable and reviewable — not
so large they bundle unrelated behaviour, not so small they're pure
busywork. If the requirements are already a single small piece of work,
one story reply is fine. If nothing here is clear enough to decompose
confidently, reply with the single word: NONE.`

function formatElement(element: ArchitectureElement): string {
  return `${element.id} (${element.kind}): ${element.name} — ${element.responsibility}`
}

function formatRequirements(requirements: Requirement[]): string {
  if (requirements.length === 0) return '(none allocated)'
  return requirements.map((r) => `${r.id}: ${r.text}`).join('\n')
}

export function buildPlanningStoryMessages(
  element: ArchitectureElement,
  requirements: Requirement[],
): LlmMessage[] {
  return [
    { role: 'system', content: STORY_DECOMPOSITION_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Architecture element:\n${formatElement(element)}\n\nAllocated requirements:\n${formatRequirements(requirements)}`,
    },
  ]
}

// Research-before-planning (Area C, resolved) — conditional: only run when
// there are genuinely multiple viable approaches, not forced on every
// story. Reply grammar mirrors defineInterfaceContract's OPERATION lines.
export const RESEARCH_STORY_SYSTEM_PROMPT = `You are the PM, running the research-before-planning step for a single
story before it is scheduled for Coding. Given the story and the
architecture element it belongs to, decide whether there are multiple
viable implementation approaches (competing libraries, patterns, or
algorithms) worth surfacing to the human before work starts.

If there are, reply using exactly these line formats, nothing else:

OPTION: <short option name>|<one-line trade-off>
  One line per viable option, 2 to 4 options typical.

RECOMMEND: <option name>|<short rationale>
  Exactly one line, naming one of the OPTION names above.

If there is really only one reasonable way to implement this story, reply
with the single word: NONE — do not invent a choice where none meaningfully
exists.`

export function buildResearchMessages(element: ArchitectureElement, title: string, description: string): LlmMessage[] {
  return [
    { role: 'system', content: RESEARCH_STORY_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Architecture element:\n${formatElement(element)}\n\nStory: ${title}\n${description}`,
    },
  ]
}

// Planning chat (Area C) — open-ended PM chat, mirrors
// buildAnalystChatMessages/buildArchitectChatMessages. Reuses the STORY:
// line grammar from STORY_DECOMPOSITION_SYSTEM_PROMPT so proposals from chat
// and from Generate Stories are parsed identically (see planning.ts's
// STORY_LINE), but a chat-proposed story only gets a requirement id list
// when one or more architecture elements are given (chat can range across
// the whole backlog, not just one element), so the prompt tells the model to
// name the target element per story rather than assume a single one.
export const DEFAULT_PM_SYSTEM_PROMPT = `You are the PM, responsible for the Planning stage of a software project. You help
the user decompose architecture elements into stories, sequence them, and think through
implementation approach before Coding starts.

When you believe the conversation has surfaced a new story that should be added, propose
it on its own line using exactly this format:

STORY: <architecture element name>|<short title>|<one or two sentence description>
  <architecture element name> must exactly match the name of one of the existing
  architecture elements given to you — never invent one.

Only propose a STORY line when you are confident it reflects a real, independently
implementable piece of work, not a tentative suggestion. Do not silently create stories
yourself — proposals are always reviewed and accepted by the user before they become
real stories. You may propose more than one STORY line in a single reply if the
conversation surfaced more than one.

Otherwise, just respond conversationally to clarify ambiguity, ask follow-up questions,
or discuss sequencing and implementation trade-offs.`

function formatExistingStories(stories: Story[]): string {
  if (stories.length === 0) return '(no stories yet)'
  return stories.map((s) => `- ${s.id}: ${s.title} — ${s.description}`).join('\n')
}

export function buildPlanningChatMessages(
  elements: ArchitectureElement[],
  backlog: Backlog | null,
  userMessage: string,
  systemPrompt: string = DEFAULT_PM_SYSTEM_PROMPT,
): LlmMessage[] {
  const context =
    `Architecture elements:\n${formatExistingElements(elements)}\n\n` +
    `Existing stories:\n${formatExistingStories(backlog?.stories.filter((s) => !s.deletedAt) ?? [])}`

  return [
    { role: 'system', content: systemPrompt },
    { role: 'system', content: context },
    { role: 'user', content: userMessage },
  ]
}

function formatExistingElements(elements: ArchitectureElement[]): string {
  if (elements.length === 0) return '(none yet)'
  return elements.map((e) => `- ${e.id} (${e.kind}): ${e.name} — ${e.responsibility}`).join('\n')
}
