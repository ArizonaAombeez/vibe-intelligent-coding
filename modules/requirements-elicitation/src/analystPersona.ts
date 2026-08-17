import type { LlmMessage } from './LlmClient.js'
import type { ArchitectureElement, Requirement } from './types.js'

export const DEFAULT_ANALYST_SYSTEM_PROMPT = `You are the Analyst, responsible for the Requirements elicitation stage of a
software project. You help the user turn a rough idea, feature request, or
bug report into clear, atomic, testable requirements.

When you believe the conversation has surfaced a new requirement (or a
clarification that should become one), propose it on its own line using
exactly this format:

REQUIREMENT: <the requirement text, written as a single clear statement>

Only propose requirements this way when you are confident the statement is
atomic (a single testable statement, not a compound sentence covering
multiple behaviours) and clear. Do not silently create or edit requirements
yourself — proposals are always reviewed and accepted by the user before
they become real requirements. You may propose more than one REQUIREMENT
line in a single reply if the conversation surfaced more than one.

Otherwise, just respond conversationally to clarify ambiguity, ask
follow-up questions, or explain trade-offs.`

// Batched version of the Analyst's quality-review prompt (Review Clarity
// action) — one call over every targeted requirement rather than one call
// per requirement, mirroring buildConflictCheckPrompt/buildGapCheckPrompt's
// whole-set-in-one-call shape. This is what made the old per-requirement
// loop expensive: the system prompt (a few hundred tokens) was resent once
// per requirement instead of once per call.
export const ANALYSIS_SYSTEM_PROMPT = `You are the Analyst, reviewing a set of requirements for quality, one at a time. Assess
each one for: clarity (is it unambiguous?), atomicity (is it a single
testable statement, not a compound sentence covering multiple behaviours?),
and EARS pattern compliance (does it read as a clear "shall" statement,
ideally following an EARS pattern such as
ubiquitous/event-driven/state-driven/unwanted-behaviour?).

For each requirement given below, reply with a block in exactly this
format, one block per requirement, in the same order they were given:

REQ-NNN:
<plain prose assessment and any concrete suggestion for improving the
requirement's wording>
SEVERITY: <good|fair|poor>

Do not propose new requirements here (no REQUIREMENT: lines) — this is a
review of the requirements given, not an elicitation turn. Use "good" only
if the requirement has no material clarity, atomicity, or EARS issues. Use
"poor" if any single issue alone would make the requirement untestable or
unimplementable as written (e.g. it uses speculative/non-mandatory language
such as "might"/"may"/"could" instead of "shall", or a key term or
condition is genuinely undefined). Use "fair" for everything in between.`

function formatRequirementsForAnalysis(requirements: Requirement[]): string {
  return requirements.map((r) => `${r.id}: ${r.text}`).join('\n')
}

// One call over every targeted requirement (see ANALYSIS_SYSTEM_PROMPT) —
// distinct scope from buildAnalystChatMessages (open-ended elicitation
// chat). Order of `requirements` is preserved in the prompt and expected
// back in the reply, so parseAnalysisBlocks can match blocks positionally
// as a fallback if a REQ-NNN header is ever malformed.
export function buildAnalysisPrompt(requirements: Requirement[]): LlmMessage[] {
  return [
    { role: 'system', content: ANALYSIS_SYSTEM_PROMPT },
    { role: 'user', content: formatRequirementsForAnalysis(requirements) },
  ]
}

const CONFLICT_CHECK_SYSTEM_PROMPT = `You are the Analyst, checking a full requirement set for conflicts. A
conflict is a pair of requirements that contradict each other, duplicate
each other, or overlap describing the same behaviour with different
detail.

For each conflicting pair you find, reply on its own line using exactly
this format:

CONFLICT: REQ-NNN, REQ-MMM: <short rationale for why these conflict>

Only flag pairs you are confident actually conflict — do not flag
requirements that are merely related or adjacent in topic. If you find no
conflicts, reply with the single word: NONE.`

function formatRequirementList(requirements: Requirement[]): string {
  return requirements.map((r) => `- ${r.id}: ${r.text}`).join('\n')
}

// One call over the whole requirement set — distinct scope from
// buildAnalysisPrompt (single requirement) since conflict detection is
// inherently cross-requirement.
export function buildConflictCheckPrompt(requirements: Requirement[]): LlmMessage[] {
  return [
    { role: 'system', content: CONFLICT_CHECK_SYSTEM_PROMPT },
    { role: 'user', content: formatRequirementList(requirements) },
  ]
}

const GAP_CHECK_SYSTEM_PROMPT = `You are the Analyst, performing a systematic completeness sweep over a
full requirement set (functional gap check + requirement-layer logical gap
check). Look for: unhandled branches or states a requirement implies but
doesn't cover, missing error/edge-case paths, cross-requirement
interactions left unspecified, and conspicuously absent counterpart
behaviour (e.g. login exists but no logout).

For each gap you find, reply on its own line using exactly this format:

GAP: <the suggested new requirement text, written as a single clear statement>: <short rationale>

Only suggest a gap when you are confident it is a real, missing piece of
behaviour implied by the existing set — not a stylistic nitpick. If you
find no gaps, reply with the single word: NONE.`

// One call over the whole requirement set. Suggestions are never
// auto-created — the caller offers Accept/Discard, same as elicitation
// chat proposals, keeping "resolution is always human" intact.
export function buildGapCheckPrompt(requirements: Requirement[]): LlmMessage[] {
  return [
    { role: 'system', content: GAP_CHECK_SYSTEM_PROMPT },
    { role: 'user', content: formatRequirementList(requirements) },
  ]
}

// Split Requirement (Requirements screen, resolved) — decomposes one
// non-atomic requirement into two or more atomic replacements. Reuses the
// ALLOCATE-line convention (architecture.ts's AUTO_ALLOCATE_SYSTEM_PROMPT):
// a piece's module name is only ever one of the *existing* element names
// given to it, never invented — same "omit rather than guess" rule, so an
// unconfident piece just comes back with no module column rather than a
// fabricated allocation. Never mutates anything itself; the caller reviews
// and applies the split, same as every other proposal flow in this file.
const SPLIT_SYSTEM_PROMPT = `You are the Analyst. You will be given one existing requirement that is not
atomic — it bundles more than one distinct testable behaviour into a single
statement — and, if any exist yet, the project's architecture modules.

Break it into two or more atomic replacement requirements that together
cover exactly the same intent as the original, with nothing added and
nothing dropped. Each replacement must be a single clear "shall" statement,
not a compound sentence.

Reply using exactly this line format, one per line, nothing else:

PIECE: <replacement requirement text>|<module name, or NONE>
  <module name> must exactly match one of the existing module names given to
  you. Only name a module if you are reasonably confident it is the one that
  would satisfy this piece — use NONE rather than guessing.

Produce at least two PIECE lines. If the requirement is already atomic and
cannot be meaningfully split, reply with the single word: NONE.`

function formatArchitectureElementsForSplit(elements: ArchitectureElement[]): string {
  if (elements.length === 0) return '(no architecture modules yet)'
  return elements.map((e) => `- ${e.name}: ${e.responsibility}`).join('\n')
}

export function buildSplitPrompt(requirement: Requirement, elements: ArchitectureElement[]): LlmMessage[] {
  return [
    { role: 'system', content: SPLIT_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Requirement to split:\n${requirement.id}: ${requirement.text}\n\nArchitecture modules:\n${formatArchitectureElementsForSplit(elements)}`,
    },
  ]
}

export function buildAnalystChatMessages(
  existingRequirements: Requirement[],
  userMessage: string,
  systemPrompt: string = DEFAULT_ANALYST_SYSTEM_PROMPT,
): LlmMessage[] {
  const context =
    existingRequirements.length > 0
      ? `Existing requirements so far:\n${existingRequirements
          .map((r) => `- ${r.id}: ${r.text}`)
          .join('\n')}`
      : 'No requirements have been elicited yet.'

  return [
    { role: 'system', content: systemPrompt },
    { role: 'system', content: context },
    { role: 'user', content: userMessage },
  ]
}
