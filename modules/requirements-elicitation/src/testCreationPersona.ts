import type { LlmMessage } from './LlmClient.js'
import type { ArchitectureElement, InterfaceContract, InterfaceContractOperation, Requirement } from './types.js'

// These prompts propose WHAT tests should exist (title + requirement/
// contract linkage) — they do NOT generate test source code. Source-code
// generation is a separate, later, filesystem-writing step (vic-testing)
// that only ever runs on a proposal that has already survived the
// mechanical requirement-traceability gate (testCreation.ts's
// createTestCase) — this split exists specifically so an untraceable
// proposal never reaches the much more expensive agentic code-writing
// call, the same "reject before CLI spawn" economy the Coding-stage
// multi-element rejection already demonstrates.

export const FUNCTIONAL_TEST_PROPOSAL_SYSTEM_PROMPT = `You are QA, responsible for Test Creation. Given one architecture element
and the requirements allocated to it, propose functional tests that verify
those requirements are satisfied.

Reply using exactly this line format, one per line, nothing else:

TEST: <short title>|<REQ-NNN>[,<REQ-NNN>...]
  The requirement id list must only use ids from those given to you — never
  invent a requirement id, and never propose a test that isn't clearly
  verifying at least one of the given requirements. Every TEST line must
  reference at least one requirement id.

If none of the given requirements can be confidently turned into a test,
reply with the single word: NONE.`

export const INTEGRATION_TEST_PROPOSAL_SYSTEM_PROMPT = `You are QA, responsible for Test Creation. Given a defined interface
contract's operations between two architecture elements, propose one
integration test per operation that verifies the operation's
request/response/error behaviour described in the contract.

Reply using exactly this line format, one per line, nothing else:

TEST: <short title>|<operation name>
  <operation name> must exactly match one of the operation names given to
  you — never invent an operation.

If the contract has no operations you can confidently turn into a test,
reply with the single word: NONE.`

function formatElement(element: ArchitectureElement): string {
  return `${element.id} (${element.kind}): ${element.name} — ${element.responsibility}`
}

function formatRequirements(requirements: Requirement[]): string {
  if (requirements.length === 0) return '(none allocated)'
  return requirements.map((r) => `${r.id}: ${r.text}`).join('\n')
}

export function buildFunctionalTestProposalMessages(
  element: ArchitectureElement,
  requirements: Requirement[],
): LlmMessage[] {
  return [
    { role: 'system', content: FUNCTIONAL_TEST_PROPOSAL_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Architecture element:\n${formatElement(element)}\n\nAllocated requirements:\n${formatRequirements(requirements)}`,
    },
  ]
}

function formatOperations(operations: InterfaceContractOperation[]): string {
  return operations
    .map((op) => `- ${op.name}: ${op.description} (request: ${op.request}; response: ${op.response}; errors: ${op.errors || 'none'})`)
    .join('\n')
}

export function buildIntegrationTestProposalMessages(
  fromElement: ArchitectureElement,
  toElement: ArchitectureElement,
  contract: InterfaceContract,
): LlmMessage[] {
  return [
    { role: 'system', content: INTEGRATION_TEST_PROPOSAL_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Interface connection:\n${formatElement(fromElement)}\n${formatElement(toElement)}\n\nContract operations:\n${formatOperations(contract.operations)}`,
    },
  ]
}

// Test Creation chat (Area E) — open-ended QA chat, mirrors
// buildAnalystChatMessages/buildArchitectChatMessages/buildPlanningChatMessages.
// Reuses the TEST: line grammar from FUNCTIONAL_TEST_PROPOSAL_SYSTEM_PROMPT
// (title|REQ-NNN[,REQ-NNN...]) so chat proposals go through the exact same
// mechanical requirement-traceability gate as Generate Functional Tests
// (testCreation.ts's createTestCase) — a chat-proposed test that names an
// unallocated or invented requirement id is rejected the same way.
export const DEFAULT_QA_TEST_CREATION_SYSTEM_PROMPT = `You are QA, responsible for the Test Creation stage of a software project. You help
the user think through what functional tests are needed for an architecture element's
allocated requirements.

When you believe the conversation has surfaced a test that should be added, propose it
on its own line using exactly this format:

TEST: <short title>|<REQ-NNN>[,<REQ-NNN>...]
  The requirement id list must only use ids from the allocated requirements given to
  you — never invent a requirement id, and never propose a test that isn't clearly
  verifying at least one of them.

Only propose a TEST line when you are confident it reflects a real, useful test, not a
tentative suggestion. Do not silently create tests yourself — proposals are always
reviewed and accepted by the user before they become real tests (and are still subject
to the same requirement-traceability check as any other proposal). You may propose more
than one TEST line in a single reply if the conversation surfaced more than one.

Otherwise, just respond conversationally to clarify ambiguity or discuss test coverage
and edge cases.`

function formatRequirementsList(requirements: Requirement[]): string {
  if (requirements.length === 0) return '(none allocated)'
  return requirements.map((r) => `${r.id}: ${r.text}`).join('\n')
}

export function buildTestCreationChatMessages(
  element: ArchitectureElement | null,
  requirements: Requirement[],
  userMessage: string,
  systemPrompt: string = DEFAULT_QA_TEST_CREATION_SYSTEM_PROMPT,
): LlmMessage[] {
  const context = element
    ? `Architecture element:\n${formatElement(element)}\n\nAllocated requirements:\n${formatRequirementsList(requirements)}`
    : 'No architecture element currently selected.'

  return [
    { role: 'system', content: systemPrompt },
    { role: 'system', content: context },
    { role: 'user', content: userMessage },
  ]
}
