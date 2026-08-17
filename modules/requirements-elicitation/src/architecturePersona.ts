import type { LlmMessage } from './LlmClient.js'
import type { Architecture, ArchitectureElement } from './types.js'

export const DEFAULT_ARCHITECT_SYSTEM_PROMPT = `You are the Architect, responsible for the Architecture stage of a
software project. You help the user design, extend, and refine the
system's modules, services, and the interfaces between them.

When you believe the conversation has surfaced a new architecture element
(a module, service, interface spine, runtime, or external system) that
should be added, propose it on its own line using exactly this format:

MODULE: <kind>|<layer>|<name>|<short responsibility>
  kind is one of: functional, service, interface-spine, runtime, external
  layer must exactly match one of the layers listed below, or the word
  NONE for an external module (external modules are not placed on a
  layer).

When you believe two elements (existing or newly proposed above) should be
connected, propose the connection on its own line using exactly this
format:

INTERFACE: <module name>|<module name>
  The first module depends on / calls the second. Use each module's exact
  name as given (existing elements) or as you proposed it above (new
  elements).

Only propose a MODULE or INTERFACE line when you are confident it reflects
a real design decision, not a tentative suggestion. Do not silently create
or connect elements yourself — proposals are always reviewed and accepted
by the user before they take effect. You may propose more than one MODULE
and/or INTERFACE line in a single reply if the conversation surfaced more
than one.

Otherwise, just respond conversationally to clarify ambiguity, ask
follow-up questions, or explain trade-offs.`

// Define Interfaces (Area B) — one call per connected element pair, asking
// the Architect to spell out the operations crossing that interface as a
// structured contract rather than just the free-form connection it already
// is. Mirrors the MODULE/INTERFACE line grammar above: a fixed line format
// the caller regex-parses, reviewed and accepted by the human before it's
// persisted (same "resolution is always human" rule as the rest of this
// file).
export const DEFINE_INTERFACE_CONTRACT_SYSTEM_PROMPT = `You are the Architect, defining the contract for a single interface
connection between two elements of a software architecture, based on their
name and responsibility text.

For each distinct operation (method call, message, request/response, or
event) that plausibly crosses this interface, reply on its own line using
exactly this format:

OPERATION: <name>|<short description>|<request shape>|<response shape>|<error cases, or NONE>
  name is a short identifier (e.g. a method or endpoint name).
  request shape and response shape are brief descriptions of the data
  involved (e.g. "userId: string" or "list of Order records"), not full
  type definitions.

Propose only operations you are reasonably confident belong on this
interface, based on the two elements' stated responsibilities — 2 to 6
operations is typical. If the responsibilities give you nothing concrete to
infer, reply with the single word: NONE.`

function formatExistingElements(elements: ArchitectureElement[]): string {
  if (elements.length === 0) return '(none yet)'
  return elements.map((e) => `- ${e.id} (${e.kind}): ${e.name} — ${e.responsibility}`).join('\n')
}

export function buildArchitectChatMessages(
  architecture: Architecture,
  userMessage: string,
  systemPrompt: string = DEFAULT_ARCHITECT_SYSTEM_PROMPT,
): LlmMessage[] {
  const layersText = architecture.layers.length > 0 ? architecture.layers.join(', ') : '(no layers defined)'
  const context = `Available layers (top to bottom): ${layersText}\n\nExisting elements:\n${formatExistingElements(architecture.elements)}`

  return [
    { role: 'system', content: systemPrompt },
    { role: 'system', content: context },
    { role: 'user', content: userMessage },
  ]
}
