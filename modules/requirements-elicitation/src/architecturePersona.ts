import type { LlmMessage } from './LlmClient.js'
import type {
  Architecture,
  ArchitectureElement,
  InterfaceDefinition,
  PlatformDescriptor,
} from './types.js'

export const DEFAULT_ARCHITECT_SYSTEM_PROMPT = `You are the Architect, responsible for the Architecture stage of a
software project. You help the user design, extend, and refine the
system's modules, services, and the interfaces between them.

When you believe the conversation has surfaced a new architecture element
(a module, service, interface spine, runtime, or external system) that
should be added, propose it on its own line using exactly this format:

MODULE: <kind>|<layer>|<name>|<responsibility>
  responsibility should be one or two sentences, concrete enough to later
  infer what data/calls cross this module's interfaces from it alone (what
  it owns, what it reads or receives, what it produces or reports) — not
  just a category label.
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

OPERATION: <name>|<short description>|<request shape>|<response shape>|<error cases, or NONE>|<range, or NONE>|<resolution, or NONE>|<unit, or NONE>|<update frequency, or DRIVEN if the value has no periodic cadence and must be driven/pushed directly into the consumer before it can be read>
  name is a short identifier (e.g. a method or endpoint name).
  request shape and response shape are brief descriptions of the data
  involved (e.g. "userId: string" or "list of Order records"), not full
  type definitions.
  range is the valid minimum/maximum or enumerated set of values this
  operation's data can take (e.g. "0-100" or "PENDING|ACTIVE|CLOSED").
  resolution is the smallest meaningful increment/precision (e.g. "1" or
  "0.01").
  unit is the physical or logical unit of the value (e.g. "ms", "%",
  "count"), or NONE if the operation isn't a measured value.
  The final field is either a concrete minimum update frequency (e.g.
  "every 100ms", "on user action") or the literal word DRIVEN if the value
  is not produced periodically and must instead be driven/pushed directly
  before it can be consumed — never leave this ambiguous between the two.

Propose operations you are reasonably confident belong on this interface,
based on the two elements' stated responsibilities — 2 to 6 operations is
typical. If a responsibility is thin (a one-line summary rather than a
detailed spec), still infer the most obvious operations implied by the two
elements' names, kinds, and roles (e.g. a controller/opponent element
feeding a game engine plausibly reports a chosen move or action, and reads
back the state it needs to choose one) rather than giving up — this is a
best-effort draft the human will review and correct, not a final contract.
Only reply with the single word NONE for OPERATION lines when the two
elements are so unrelated or abstract that no plausible operation can be
inferred at all.

Then, ALWAYS — even if you replied NONE for operations — emit exactly one
DECLARE line for EACH of the two elements, describing it platform-neutrally:

DECLARE: <element id>|<what this element does, one line>|<exposes: names of the function calls or signals it offers other elements, semicolon-separated, or NONE>|<owns: names of the data it owns, semicolon-separated, or NONE>|<visibleTo: element ids that may see its owned data, semicolon-separated, or ALL, or NONE>
  Use the element id exactly as given (e.g. ARCH-003).
  "exposes" are conceptual call/signal names, never a language or framework
  construct — no return types, no syntax.
  "owns" is the data this element is the single owner of; nothing is global,
  every datum has exactly one owning element.
  "visibleTo" says which other elements are allowed to read that owned data.
  Do not name any language, framework, platform, or wiring mechanism
  anywhere in a DECLARE line — how these are realised is decided later.`

function formatExistingElements(elements: ArchitectureElement[]): string {
  if (elements.length === 0) return '(none yet)'
  return elements.map((e) => `- ${e.id} (${e.kind}): ${e.name} — ${e.responsibility}`).join('\n')
}

// Define Harness (project harness feature) — one call producing the plan
// for how THIS project's single harness element realises its entry point,
// element instantiation, inter-element links and run lifecycle on the
// currently selected platform. Same fixed-line-grammar, human-reviewed
// pattern as the rest of this file. The caller (deriveHarnessSpec in
// architecture.ts) supplies the platform hints, the checklist keys, the
// element inventory and the interface definitions as a user message.
export const DEFINE_HARNESS_SPEC_SYSTEM_PROMPT = `You are the Architect, defining how a project's HARNESS is realised on a
specific target platform.

The harness is the single composition root and entry point of the project.
Its job — and ONLY its job — is to: own the platform entry point;
instantiate every functional element; establish the declared connections
between elements; and drive the run lifecycle. It contains no functional
logic of its own. Every other element is implemented in isolation and must
NOT create an entry point or wire anything — the harness does all of it.

You are given: the target platform and how entry points / wiring /
lifecycle conventionally look on it; a fixed checklist of harness concerns;
the list of elements to instantiate; and the platform-neutral interface
declarations describing what each element exposes and owns.

Reply using exactly these line formats, nothing else:

CHECK: <key>|<applies or not-applicable>|<one sentence: how this concern is realised on this platform, or why it does not apply>
  One line for EVERY checklist key given, in any order.

LINK: <interface definition id>|<one sentence naming the concrete platform mechanism that realises this connection between the two elements>
  One line for EVERY interface definition given. Name the real mechanism
  for THIS platform (e.g. "constructor injection in main()", "an Android
  ViewModel exposing a StateFlow the other observes", "a shared event bus
  subscription") — this is the per-link realisation note the harness code
  will be written to match.

NARRATIVE: <one paragraph, plain prose, tying the above together: the file(s) that form the entry point, the order elements are constructed in, and how the run is started and stopped>

Be concrete and specific to the given platform. Do not invent elements or
interfaces that were not given to you.`

export function buildHarnessSpecMessages(
  platform: PlatformDescriptor,
  checklistKeys: ReadonlyArray<{ key: string; description: string }>,
  elements: ArchitectureElement[],
  interfaceDefinitions: InterfaceDefinition[],
): LlmMessage[] {
  const platformBlock = [
    `Target platform: ${platform.label} (${platform.id})`,
    `Entry point on this platform: ${platform.entryPointHint}`,
    `Wiring on this platform: ${platform.wiringHint}`,
    `Run lifecycle on this platform: ${platform.lifecycleHint}`,
  ].join('\n')

  const checklistBlock = checklistKeys.map((c) => `- ${c.key}: ${c.description}`).join('\n')

  const elementBlock =
    elements.length > 0
      ? elements.map((e) => `- ${e.id} (${e.kind}): ${e.name} — ${e.responsibility}`).join('\n')
      : '(no elements yet — the harness may have nothing to instantiate; still describe the entry point)'

  const declByElement = new Map<string, string[]>()
  for (const def of interfaceDefinitions) {
    for (const decl of def.declarations ?? []) {
      const lines = declByElement.get(decl.elementId) ?? []
      lines.push(
        `exposes: ${decl.exposes.join('; ') || 'NONE'}; owns: ${decl.owns.join('; ') || 'NONE'}; visibleTo: ${decl.visibleTo.join('; ') || 'NONE'}`,
      )
      declByElement.set(decl.elementId, lines)
    }
  }
  const declarationBlock =
    declByElement.size > 0
      ? Array.from(declByElement.entries())
          .map(([id, lines]) => `- ${id}: ${lines[0]}`)
          .join('\n')
      : '(no interface declarations yet)'

  const interfaceBlock =
    interfaceDefinitions.length > 0
      ? interfaceDefinitions
          .map((d) => {
            const parts = d.participants.map((p) => `${p.elementId} (${p.role})`).join(', ')
            const ops = d.operations.map((o) => o.name).join(', ') || 'none listed'
            return `- ${d.id} "${d.name}": between ${parts}; operations: ${ops}`
          })
          .join('\n')
      : '(no interface definitions yet — emit no LINK lines)'

  const userContent = [
    platformBlock,
    `\nHarness checklist keys (emit one CHECK line for each):\n${checklistBlock}`,
    `\nElements to instantiate:\n${elementBlock}`,
    `\nPlatform-neutral element declarations:\n${declarationBlock}`,
    `\nInterface definitions (emit one LINK line for each):\n${interfaceBlock}`,
  ].join('\n')

  return [
    { role: 'system', content: DEFINE_HARNESS_SPEC_SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ]
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
