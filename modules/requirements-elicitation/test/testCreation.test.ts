import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  setArchitectureType,
  createArchitectureElement,
  acceptProposedInterface,
  defineInterfaceDefinition,
  createRequirementFromForm as createRequirementFromFormReal,
  reassignArchitectureElement,
  createTestCase,
  updateTestCase,
  deleteTestCase,
  generateFunctionalTestsForElement,
  generateIntegrationTestsForContract,
  generateAllTestsForUnplannedElements,
} from '../src/index.js'
import type {
  LlmCallOptions,
  LlmChatResult,
  LlmClient,
  LlmMessage,
  Project,
  CreateRequirementFields,
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

function elementWithRequirement(project: Project) {
  setArchitectureType(project, 'custom')
  const element = createArchitectureElement(project, {
    kind: 'functional',
    name: 'Login',
    responsibility: 'Handles login',
    row: 0,
    col: 0,
  })
  const requirement = createRequirementFromForm(project, { text: 'The system shall render a login form' })
  reassignArchitectureElement(project, requirement.id, element.id)
  return { element, requirement }
}

test('createTestCase rejects a functional test with no requirement ids', () => {
  const project = emptyProject()
  const { element } = elementWithRequirement(project)

  const result = createTestCase(project, {
    type: 'functional',
    title: 'Some test',
    architectureElementId: element.id,
  })

  assert.equal(result.testCase, null)
  assert.equal(result.rejected, 'no-requirement-ids')
  assert.deepEqual(project.testSuite?.tests ?? [], [])
})

test('createTestCase rejects a functional test referencing an unknown requirement id', () => {
  const project = emptyProject()
  const { element } = elementWithRequirement(project)

  const result = createTestCase(project, {
    type: 'functional',
    title: 'Some test',
    requirementIds: ['REQ-999'],
    architectureElementId: element.id,
  })

  assert.equal(result.testCase, null)
  assert.equal(result.rejected, 'requirement-not-found')
})

test('createTestCase rejects a functional test referencing a soft-deleted requirement', () => {
  const project = emptyProject()
  const { element, requirement } = elementWithRequirement(project)
  requirement.deletedAt = new Date().toISOString()

  const result = createTestCase(project, {
    type: 'functional',
    title: 'Some test',
    requirementIds: [requirement.id],
    architectureElementId: element.id,
  })

  assert.equal(result.rejected, 'requirement-not-found')
})

test('createTestCase rejects a functional test whose requirement is allocated to a different element', () => {
  const project = emptyProject()
  const { requirement } = elementWithRequirement(project)
  const otherElement = createArchitectureElement(project, {
    kind: 'functional',
    name: 'Other',
    responsibility: 'Does something else',
    row: 0,
    col: 1,
  })

  const result = createTestCase(project, {
    type: 'functional',
    title: 'Some test',
    requirementIds: [requirement.id],
    architectureElementId: otherElement.id,
  })

  assert.equal(result.rejected, 'requirement-not-allocated-to-element')
  assert.deepEqual(project.testSuite?.tests ?? [], [])
})

test('createTestCase accepts a functional test whose requirement is correctly allocated', () => {
  const project = emptyProject()
  const { element, requirement } = elementWithRequirement(project)

  const result = createTestCase(project, {
    type: 'functional',
    title: 'Renders login form',
    requirementIds: [requirement.id],
    architectureElementId: element.id,
  })

  assert.ok(result.testCase)
  assert.equal(result.testCase?.id, 'TEST-001')
  assert.equal(result.rejected, undefined)
  assert.equal(project.testSuite?.tests.length, 1)
})

function twoConnectedElements(project: Project) {
  setArchitectureType(project, 'custom')
  const from = createArchitectureElement(project, {
    kind: 'functional',
    name: 'Order Service',
    responsibility: 'Manages orders',
    row: 0,
    col: 0,
  })
  const to = createArchitectureElement(project, {
    kind: 'functional',
    name: 'Payment Service',
    responsibility: 'Processes payments',
    row: 0,
    col: 1,
  })
  acceptProposedInterface(project, from.id, to.id)
  return { from, to }
}

test('createTestCase rejects an integration test with no contract ref', () => {
  const project = emptyProject()
  twoConnectedElements(project)

  const result = createTestCase(project, { type: 'integration', title: 'Some test' })

  assert.equal(result.rejected, 'no-contract-ref')
})

test('createTestCase rejects an integration test whose contract does not exist', () => {
  const project = emptyProject()
  twoConnectedElements(project)

  const result = createTestCase(project, {
    type: 'integration',
    title: 'Some test',
    interfaceDefinitionId: 'IFACE-999',
  })

  assert.equal(result.rejected, 'contract-not-found')
})

test('createTestCase rejects an integration test whose contract has zero operations', async () => {
  const project = emptyProject()
  const { from, to } = twoConnectedElements(project)
  const { definition } = await defineInterfaceDefinition(project, new FakeLlmClient('NONE'), from.id, to.id)

  const result = createTestCase(project, {
    type: 'integration',
    title: 'Some test',
    interfaceDefinitionId: definition.id,
  })

  assert.equal(result.rejected, 'contract-not-defined')
})

test('createTestCase accepts an integration test against a defined contract with operations', async () => {
  const project = emptyProject()
  const { from, to } = twoConnectedElements(project)
  const { definition } = await defineInterfaceDefinition(
    project,
    new FakeLlmClient('OPERATION: chargeCard|Charges the customer|orderId|receiptId|NONE'),
    from.id,
    to.id,
  )

  const result = createTestCase(project, {
    type: 'integration',
    title: 'Charges the customer',
    interfaceDefinitionId: definition.id,
    interfaceElementIds: [from.id, to.id],
  })

  assert.ok(result.testCase)
  assert.equal(result.testCase?.type, 'integration')
})

test('updateTestCase edits fields in place and throws for an unknown id', () => {
  const project = emptyProject()
  const { element, requirement } = elementWithRequirement(project)
  const { testCase } = createTestCase(project, {
    type: 'functional',
    title: 'A test',
    requirementIds: [requirement.id],
    architectureElementId: element.id,
  })

  const updated = updateTestCase(project, testCase!.id, { status: 'passing' })
  assert.equal(updated.status, 'passing')
  assert.throws(() => updateTestCase(project, 'TEST-999', { status: 'passing' }), /TEST-999/)
})

test('deleteTestCase soft-deletes', () => {
  const project = emptyProject()
  const { element, requirement } = elementWithRequirement(project)
  const { testCase } = createTestCase(project, {
    type: 'functional',
    title: 'A test',
    requirementIds: [requirement.id],
    architectureElementId: element.id,
  })

  deleteTestCase(project, testCase!.id)
  assert.ok(project.testSuite?.tests.find((t) => t.id === testCase!.id)?.deletedAt)
})

test('generateFunctionalTestsForElement parses TEST lines and routes every proposal through the traceability gate', async () => {
  const project = emptyProject()
  const { element, requirement } = elementWithRequirement(project)
  const other = createRequirementFromForm(project, { text: 'Unrelated requirement' })

  const fake = new FakeLlmClient(
    `TEST: Renders login form|${requirement.id}\n` + `TEST: Invented test|${other.id}`,
  )
  const result = await generateFunctionalTestsForElement(project, fake, element.id)

  assert.equal(result.tests.length, 1)
  assert.equal(result.tests[0].requirementIds[0], requirement.id)
  assert.equal(result.rejected.length, 1)
  assert.equal(result.rejected[0].reason, 'requirement-not-allocated-to-element')
})

test('generateFunctionalTestsForElement skips the LLM call when unitTestMode is disabled', async () => {
  const project = emptyProject()
  const { element } = elementWithRequirement(project)
  project.settings = { phaseTabGating: 'always-accessible', unitTestMode: 'disabled' }

  const fake = new FakeLlmClient('TEST: Should not be called|REQ-001')
  const result = await generateFunctionalTestsForElement(project, fake, element.id)

  assert.deepEqual(result.tests, [])
  assert.equal(fake.receivedMessages.length, 0)
})

test('generateIntegrationTestsForContract throws when the contract has no defined operations', async () => {
  const project = emptyProject()
  const { from, to } = twoConnectedElements(project)
  const fake = new FakeLlmClient('NONE')

  await assert.rejects(() => generateIntegrationTestsForContract(project, fake, from.id, to.id))
})

test('generateIntegrationTestsForContract only accepts TEST lines naming a real operation', async () => {
  const project = emptyProject()
  const { from, to } = twoConnectedElements(project)
  await defineInterfaceDefinition(
    project,
    new FakeLlmClient('OPERATION: chargeCard|Charges|orderId|receiptId|NONE'),
    from.id,
    to.id,
  )

  const fake = new FakeLlmClient('TEST: Charges the card|chargeCard\nTEST: Invented op|notReal')
  const result = await generateIntegrationTestsForContract(project, fake, from.id, to.id)

  assert.equal(result.tests.length, 1)
  assert.equal(result.rejected.length, 0, 'an invented operation name never reaches the traceability gate, so it is silently dropped, not rejected')
})

test('generateAllTestsForUnplannedElements skips an element only once every allocated requirement has a test', async () => {
  const project = emptyProject()
  const { element, requirement } = elementWithRequirement(project)
  createTestCase(project, {
    type: 'functional',
    title: 'Already covered',
    requirementIds: [requirement.id],
    architectureElementId: element.id,
  })
  const unplanned = createArchitectureElement(project, {
    kind: 'functional',
    name: 'Unplanned',
    responsibility: 'Needs tests',
    row: 0,
    col: 1,
  })
  const unplannedReq = createRequirementFromForm(project, { text: 'The system shall do the unplanned thing' })
  reassignArchitectureElement(project, unplannedReq.id, unplanned.id)

  const fake = new FakeLlmClient(`TEST: New test|${unplannedReq.id}`)
  const result = await generateAllTestsForUnplannedElements(project, fake)

  assert.equal(result.tests.length, 1)
  assert.equal(result.tests[0].architectureElementId, unplanned.id)
  assert.equal(fake.receivedMessages.length, 1, 'only one LLM call, for the fully-untested element')
})

test('generateAllTestsForUnplannedElements tops up a partially-tested element with only its untested requirements', async () => {
  const project = emptyProject()
  const { element, requirement: coveredReq } = elementWithRequirement(project)
  createTestCase(project, {
    type: 'functional',
    title: 'Already covered',
    requirementIds: [coveredReq.id],
    architectureElementId: element.id,
  })
  const gapReq = createRequirementFromForm(project, { text: 'The system shall do the uncovered thing' })
  reassignArchitectureElement(project, gapReq.id, element.id)

  const fake = new FakeLlmClient(`TEST: Gap test|${gapReq.id}`)
  const result = await generateAllTestsForUnplannedElements(project, fake)

  assert.equal(result.tests.length, 1)
  assert.equal(result.tests[0].requirementIds[0], gapReq.id)
  assert.equal(fake.receivedMessages.length, 1, 'the partially-tested element is not skipped')
  const userMessage = fake.receivedMessages[0].find((m) => m.role === 'user')!.content
  assert.match(userMessage, new RegExp(gapReq.id), 'only the untested requirement is sent, not the already-covered one')
  assert.doesNotMatch(userMessage, new RegExp(coveredReq.id))
})
