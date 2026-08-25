import {
  buildFunctionalTestProposalMessages,
  buildIntegrationTestProposalMessages,
  buildTestCreationChatMessages,
} from './testCreationPersona.js'
import { connectedPairs } from './architecture.js'
import type { LlmCallOptions, LlmClient, LlmUsage } from './LlmClient.js'
import type { Project, Requirement, TestCase, TestSuite, TestType } from './types.js'

function requireTestSuite(project: Project): TestSuite {
  if (!project.testSuite) {
    project.testSuite = { tests: [], nextTestSeq: 1 }
  }
  return project.testSuite
}

function activeTests(suite: TestSuite): TestCase[] {
  return suite.tests.filter((t) => !t.deletedAt)
}

export interface CreateTestCaseFields {
  type: TestType
  title: string
  requirementIds?: string[]
  interfaceDefinitionId?: string
  architectureElementId?: string | null
  interfaceElementIds?: [string, string]
}

export type TraceabilityRejectionReason =
  | 'no-requirement-ids'
  | 'requirement-not-found'
  | 'requirement-not-allocated-to-element'
  | 'no-contract-ref'
  | 'contract-not-found'
  | 'contract-not-defined'

export interface CreateTestCaseResult {
  testCase: TestCase | null
  rejected?: TraceabilityRejectionReason
}

// The requirement traceability gate (Area E, resolved) — mechanical,
// checked here against project.requirements / architecture.interfaceDefinitions
// directly, never trusting the caller's claim that a link is valid. Every
// TestCase persisted into project.testSuite has gone through this
// function; there is no other path that pushes onto suite.tests. On
// rejection, nothing is pushed and the reason is always returned, never
// silently dropped — matches Area E's resolved "flagged... inline badge +
// reason... never silently created and never silently dropped" rule.
export function createTestCase(project: Project, fields: CreateTestCaseFields): CreateTestCaseResult {
  const suite = requireTestSuite(project)

  if (fields.type === 'functional') {
    const requirementIds = fields.requirementIds ?? []
    if (requirementIds.length === 0) {
      return { testCase: null, rejected: 'no-requirement-ids' }
    }
    const resolved = requirementIds.map((id) => project.requirements.find((r) => r.id === id && !r.deletedAt))
    if (resolved.some((r) => !r)) {
      return { testCase: null, rejected: 'requirement-not-found' }
    }
    const requirements = resolved as NonNullable<(typeof resolved)[number]>[]
    const targetElementId = fields.architectureElementId ?? null
    if (requirements.some((r) => !targetElementId || !r.architectureElements.includes(targetElementId))) {
      return { testCase: null, rejected: 'requirement-not-allocated-to-element' }
    }
  } else {
    if (!fields.interfaceDefinitionId) {
      return { testCase: null, rejected: 'no-contract-ref' }
    }
    const definition = (project.architecture?.interfaceDefinitions ?? []).find(
      (d) => d.id === fields.interfaceDefinitionId,
    )
    if (!definition) {
      return { testCase: null, rejected: 'contract-not-found' }
    }
    if (definition.status !== 'defined' || definition.operations.length === 0) {
      return { testCase: null, rejected: 'contract-not-defined' }
    }
  }

  const seq = suite.nextTestSeq
  const testCase: TestCase = {
    id: `TEST-${String(seq).padStart(3, '0')}`,
    type: fields.type,
    title: fields.title,
    requirementIds: fields.requirementIds ?? [],
    interfaceDefinitionId: fields.interfaceDefinitionId,
    architectureElementId: fields.architectureElementId ?? null,
    interfaceElementIds: fields.interfaceElementIds,
    status: 'not-run',
    createdAt: new Date().toISOString(),
  }
  suite.nextTestSeq = seq + 1
  suite.tests.push(testCase)
  return { testCase }
}

export interface UpdateTestCaseFields {
  title?: string
  status?: TestCase['status']
  filePath?: string
  lastRunAt?: string
}

export function updateTestCase(project: Project, testId: string, fields: UpdateTestCaseFields): TestCase {
  const suite = requireTestSuite(project)
  const testCase = suite.tests.find((t) => t.id === testId)
  if (!testCase) {
    throw new Error(`Test case ${testId} not found`)
  }
  Object.assign(testCase, fields)
  return testCase
}

export function deleteTestCase(project: Project, testId: string): void {
  const suite = requireTestSuite(project)
  const testCase = suite.tests.find((t) => t.id === testId)
  if (!testCase) {
    throw new Error(`Test case ${testId} not found`)
  }
  testCase.deletedAt = new Date().toISOString()
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

const TEST_LINE = /^TEST:\s*([^|]+)\|\s*(.*)$/gm

export interface RejectedProposal {
  title: string
  reason: TraceabilityRejectionReason
}

export interface GenerateFunctionalTestsResult {
  tests: TestCase[]
  rejected: RejectedProposal[]
  usage?: LlmUsage
}

// "Generate Functional Tests" (Area E, req: functional tests derived from
// allocated requirements). Unit test generation mode handling (Area E,
// resolved requirements 53-54): 'disabled' skips the LLM call entirely;
// 'scaffold' currently behaves identically to 'llm' until a concrete
// per-language scaffold template exists (confirmed acceptable — no
// language is fixed anywhere in generated code yet).
export async function generateFunctionalTestsForElement(
  project: Project,
  llmClient: LlmClient,
  architectureElementId: string,
  llmOptions?: LlmCallOptions,
): Promise<GenerateFunctionalTestsResult> {
  if (!project.architecture) {
    throw new Error('Project has no architecture — select an Architecture type first')
  }
  const allocated = project.requirements.filter(
    (r) => !r.deletedAt && r.architectureElements.includes(architectureElementId),
  )
  return generateFunctionalTestsForRequirements(project, llmClient, architectureElementId, allocated, llmOptions)
}

// Shared by generateFunctionalTestsForElement (always proposes against every
// allocated requirement) and generateAllTestsForUnplannedElements (proposes
// only against requirements that don't have a functional test yet, so a
// top-up run fills gaps within an already-partially-tested element instead
// of skipping it outright).
async function generateFunctionalTestsForRequirements(
  project: Project,
  llmClient: LlmClient,
  architectureElementId: string,
  requirements: Requirement[],
  llmOptions?: LlmCallOptions,
): Promise<GenerateFunctionalTestsResult> {
  const mode = project.settings?.unitTestMode ?? 'llm'
  if (mode === 'disabled') {
    return { tests: [], rejected: [] }
  }
  if (!project.architecture) {
    throw new Error('Project has no architecture — select an Architecture type first')
  }
  const element = project.architecture.elements.find((e) => e.id === architectureElementId)
  if (!element) {
    throw new Error(`Architecture element ${architectureElementId} not found`)
  }

  const messages = buildFunctionalTestProposalMessages(element, requirements)
  const result = await llmClient.chat(messages, llmOptions)

  if (result.content.trim() === 'NONE') {
    return { tests: [], rejected: [], usage: result.usage }
  }

  const tests: TestCase[] = []
  const rejected: RejectedProposal[] = []
  for (const m of result.content.matchAll(TEST_LINE)) {
    const title = m[1].trim()
    const requirementIds = m[2]
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0)
    const { testCase, rejected: reason } = createTestCase(project, {
      type: 'functional',
      title,
      requirementIds,
      architectureElementId,
    })
    if (testCase) {
      tests.push(testCase)
    } else if (reason) {
      rejected.push({ title, reason })
    }
  }
  return { tests, rejected, usage: result.usage }
}

export interface GenerateIntegrationTestsResult {
  tests: TestCase[]
  rejected: RejectedProposal[]
  usage?: LlmUsage
}

// "Generate Integration Tests" (Area E, resolved "Integration tests"
// section) — one LLM call per connected pair, only for a connection with a
// status: 'defined' contract carrying at least one operation. Throws (not
// silently no-ops) if the pair/contract precondition isn't met — a
// precondition error (caller passed a bad pair), distinct from the
// traceability gate's per-test rejection which is about individual
// proposal lines, not the whole call.
export async function generateIntegrationTestsForContract(
  project: Project,
  llmClient: LlmClient,
  fromId: string,
  toId: string,
  llmOptions?: LlmCallOptions,
): Promise<GenerateIntegrationTestsResult> {
  if (!project.architecture) {
    throw new Error('Project has no architecture — select an Architecture type first')
  }
  const fromElement = project.architecture.elements.find((e) => e.id === fromId)
  const toElement = project.architecture.elements.find((e) => e.id === toId)
  if (!fromElement || !toElement) {
    throw new Error('Both architecture elements must exist to generate integration tests')
  }
  const definition = (project.architecture.interfaceDefinitions ?? []).find(
    (d) => d.participants.some((p) => p.elementId === fromId) && d.participants.some((p) => p.elementId === toId),
  )
  if (!definition || definition.status !== 'defined' || definition.operations.length === 0) {
    throw new Error('This interface connection has no defined contract with operations — run Define Interfaces first')
  }

  const messages = buildIntegrationTestProposalMessages(fromElement, toElement, definition)
  const result = await llmClient.chat(messages, llmOptions)

  if (result.content.trim() === 'NONE') {
    return { tests: [], rejected: [], usage: result.usage }
  }

  const validOperationNames = new Set(definition.operations.map((op) => op.name))
  const tests: TestCase[] = []
  const rejected: RejectedProposal[] = []
  for (const m of result.content.matchAll(TEST_LINE)) {
    const title = m[1].trim()
    const operationName = m[2].trim()
    if (!validOperationNames.has(operationName)) continue // invented operation name — silently dropped, not a traceability-gate rejection since it never reaches createTestCase
    const { testCase, rejected: reason } = createTestCase(project, {
      type: 'integration',
      title,
      interfaceDefinitionId: definition.id,
      interfaceElementIds: [fromId, toId],
    })
    if (testCase) {
      tests.push(testCase)
    } else if (reason) {
      rejected.push({ title, reason })
    }
  }
  return { tests, rejected, usage: result.usage }
}

export interface GenerateAllTestsResult {
  tests: TestCase[]
  rejected: RejectedProposal[]
  usage?: LlmUsage
}

// Non-destructive top-up, mirrors generateStoriesForAllUnplannedElements —
// but at requirement granularity for functional tests, not element
// granularity: a requirement with no active functional test yet is a gap
// even if its element already has tests for other requirements, so an
// element is only skipped once every one of its allocated requirements is
// covered. Integration tests stay pair-level (a TestCase only records the
// fromId/toId pair, not which contract operation it covers, so "has this
// pair got any active integration test yet" is the finest signal available).
// The single "Generate All" action the UI's action bar calls.
export async function generateAllTestsForUnplannedElements(
  project: Project,
  llmClient: LlmClient,
  llmOptions?: LlmCallOptions,
): Promise<GenerateAllTestsResult> {
  if (!project.architecture) {
    throw new Error('Project has no architecture — select an Architecture type first')
  }
  const suite = requireTestSuite(project)
  const tested = activeTests(suite)

  const testedRequirementIds = new Set(
    tested.filter((t) => t.type === 'functional').flatMap((t) => t.requirementIds),
  )
  const testedDefinitionIds = new Set(
    tested.filter((t) => t.type === 'integration' && t.interfaceDefinitionId).map((t) => t.interfaceDefinitionId!),
  )

  const allTests: TestCase[] = []
  const allRejected: RejectedProposal[] = []
  let usage: LlmUsage | undefined

  for (const element of project.architecture.elements) {
    const allocated = project.requirements.filter((r) => !r.deletedAt && r.architectureElements.includes(element.id))
    const untested = allocated.filter((r) => !testedRequirementIds.has(r.id))
    if (untested.length === 0) continue
    const result = await generateFunctionalTestsForRequirements(project, llmClient, element.id, untested, llmOptions)
    allTests.push(...result.tests)
    allRejected.push(...result.rejected)
    usage = addUsage(usage, result.usage)
  }

  const definitions = project.architecture.interfaceDefinitions ?? []
  for (const pair of connectedPairs(project.architecture.elements)) {
    const definition = definitions.find(
      (d) => d.participants.some((p) => p.elementId === pair.fromId) && d.participants.some((p) => p.elementId === pair.toId),
    )
    if (!definition || definition.status !== 'defined' || definition.operations.length === 0) continue
    if (testedDefinitionIds.has(definition.id)) continue
    const result = await generateIntegrationTestsForContract(project, llmClient, pair.fromId, pair.toId, llmOptions)
    allTests.push(...result.tests)
    allRejected.push(...result.rejected)
    usage = addUsage(usage, result.usage)
  }

  return { tests: allTests, rejected: allRejected, usage }
}

export interface ProposedTest {
  title: string
  requirementIds: string[]
}

function extractProposedTests(reply: string): ProposedTest[] {
  return Array.from(reply.matchAll(TEST_LINE), (m) => ({
    title: m[1].trim(),
    requirementIds: m[2]
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  }))
}

export interface ChatWithQATestCreationResult {
  reply: string
  proposedTests: ProposedTest[]
  usage?: LlmUsage
}

// QA Test-Creation-chat path (mirrors chatWithAnalyst/chatWithArchitect/
// chatWithPM) — does not save anything. Proposed tests are returned for the
// human to accept or discard; the caller invokes createTestCase for each
// accepted proposal (same mechanical traceability gate as Generate
// Functional Tests — an untraceable accepted proposal is still rejected
// there, this function does not pre-filter against it).
export async function chatWithQATestCreation(
  project: Project,
  llmClient: LlmClient,
  architectureElementId: string | null,
  userMessage: string,
  llmOptions?: LlmCallOptions,
): Promise<ChatWithQATestCreationResult> {
  const element = architectureElementId
    ? (project.architecture?.elements.find((e) => e.id === architectureElementId) ?? null)
    : null
  const allocated: Requirement[] = element
    ? project.requirements.filter((r) => !r.deletedAt && r.architectureElements.includes(element.id))
    : []

  const messages = buildTestCreationChatMessages(element, allocated, userMessage)
  const result = await llmClient.chat(messages, llmOptions)
  return {
    reply: result.content,
    proposedTests: extractProposedTests(result.content),
    usage: result.usage,
  }
}
