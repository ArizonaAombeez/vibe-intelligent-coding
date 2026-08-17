import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  setArchitectureType,
  createArchitectureElement,
  updateArchitectureElement,
  deleteArchitectureElement,
  addLayer,
  removeLayer,
  checkArchitectureConflicts,
  autoConfigureAndAllocate,
  autoAllocateHeuristic,
  autoAllocateLlm,
  acceptProposedInterface,
  defineInterfaceContract,
  defineAllInterfaceContracts,
  checkInterfaces,
  EXTERNAL_CONTEXT_ROW,
  createRequirementFromForm as createRequirementFromFormReal,
  reassignArchitectureElement,
} from '../src/index.js'
import type {
  LlmCallOptions,
  LlmChatResult,
  LlmClient,
  LlmMessage,
  Project,
  CreateRequirementFields,
  Requirement,
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

// Requirement ids come from a global counter in real use (see
// globalSeqStore.ts); tests fake it with a per-project counter so each
// fresh emptyProject() still gets REQ-001, REQ-002, ... in order.
const seqByProject = new WeakMap<Project, number>()
function createRequirementFromForm(project: Project, fields: CreateRequirementFields): Requirement {
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

// One reply per call, in order (last reply repeats if there are more calls
// than replies) — used for autoAllocateLlm's batching tests, where each
// batch is a separate LLM call and needs its own scripted reply.
class MultiReplyFakeLlmClient implements LlmClient {
  public receivedMessages: LlmMessage[][] = []
  private callIndex = 0
  constructor(private readonly replies: string[]) {}

  async chat(messages: LlmMessage[]): Promise<LlmChatResult> {
    this.receivedMessages.push(messages)
    const content = this.replies[this.callIndex] ?? this.replies[this.replies.length - 1]
    this.callIndex++
    return { content, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }
  }
}

test('setArchitectureType seeds the grid with the preset default layers', () => {
  const project = emptyProject()
  setArchitectureType(project, 'web-app')

  assert.equal(project.architectureType, 'web-app')
  assert.deepEqual(project.architecture?.layers, ['UI', 'Service', 'Data'])
  assert.deepEqual(project.architecture?.elements, [])
})

test('setArchitectureType does not wipe existing elements when re-selected', () => {
  const project = emptyProject()
  setArchitectureType(project, 'web-app')
  createArchitectureElement(project, {
    kind: 'functional',
    name: 'Login',
    responsibility: 'Handles login',
    row: 0,
    col: 0,
  })

  setArchitectureType(project, 'web-app')

  assert.equal(project.architecture?.elements.length, 1, 're-selecting the same type must not wipe elements')
})

test('createArchitectureElement assigns sequential ARCH-NNN ids', () => {
  const project = emptyProject()
  setArchitectureType(project, 'custom')

  const e1 = createArchitectureElement(project, {
    kind: 'functional',
    name: 'Frontend',
    responsibility: 'Renders UI',
    row: 0,
    col: 0,
  })
  const e2 = createArchitectureElement(project, {
    kind: 'service',
    name: 'API',
    responsibility: 'Serves requests',
    row: 1,
    col: 0,
  })

  assert.equal(e1.id, 'ARCH-001')
  assert.equal(e2.id, 'ARCH-002')
  assert.equal(e1.rowSpan, 1)
  assert.equal(e1.colSpan, 1)
  assert.deepEqual(e1.interfaces, [])
})

test('createArchitectureElement throws when no architecture type has been selected', () => {
  const project = emptyProject()
  assert.throws(
    () =>
      createArchitectureElement(project, {
        kind: 'functional',
        name: 'X',
        responsibility: 'Y',
        row: 0,
        col: 0,
      }),
    /architecture/i,
  )
})

test('updateArchitectureElement edits fields in place', () => {
  const project = emptyProject()
  setArchitectureType(project, 'custom')
  const element = createArchitectureElement(project, {
    kind: 'functional',
    name: 'Frontend',
    responsibility: 'Renders UI',
    row: 0,
    col: 0,
  })

  const updated = updateArchitectureElement(project, element.id, {
    name: 'Web Frontend',
    dynamicDesignEnabled: true,
  })

  assert.equal(updated.name, 'Web Frontend')
  assert.equal(updated.dynamicDesignEnabled, true)
  assert.equal(updated.responsibility, 'Renders UI', 'unspecified fields must be left unchanged')
})

test('updateArchitectureElement throws for an unknown element id', () => {
  const project = emptyProject()
  setArchitectureType(project, 'custom')
  assert.throws(() => updateArchitectureElement(project, 'ARCH-999', { name: 'x' }), /ARCH-999/)
})

test('deleteArchitectureElement removes the element and clears dangling references', () => {
  const project = emptyProject()
  setArchitectureType(project, 'custom')
  const frontend = createArchitectureElement(project, {
    kind: 'functional',
    name: 'Frontend',
    responsibility: 'Renders UI',
    row: 0,
    col: 0,
  })
  const api = createArchitectureElement(project, {
    kind: 'service',
    name: 'API',
    responsibility: 'Serves requests',
    row: 1,
    col: 0,
    interfaces: [frontend.id],
  })
  const requirement = createRequirementFromForm(project, { text: 'The system shall render UI' })
  reassignArchitectureElement(project, requirement.id, frontend.id)

  deleteArchitectureElement(project, frontend.id)

  assert.equal(project.architecture?.elements.length, 1)
  assert.deepEqual(project.architecture?.elements[0].interfaces, [], 'dangling interface reference must be cleared')
  assert.deepEqual(project.requirements[0].architectureElements, [], 'requirement must fall back to unallocated')
  assert.equal(api.id, 'ARCH-002', 'surviving element keeps its own id')
})

test('deleteArchitectureElement throws for an unknown element id', () => {
  const project = emptyProject()
  setArchitectureType(project, 'custom')
  assert.throws(() => deleteArchitectureElement(project, 'ARCH-999'), /ARCH-999/)
})

test('addLayer appends a new layer row', () => {
  const project = emptyProject()
  setArchitectureType(project, 'custom')
  addLayer(project, 'Infra')
  assert.deepEqual(project.architecture?.layers, ['Infra'])
})

test('removeLayer deletes a row and shifts elements below it up by one', () => {
  const project = emptyProject()
  setArchitectureType(project, 'web-app') // ['UI', 'Service', 'Data']
  const dataElement = createArchitectureElement(project, {
    kind: 'functional',
    name: 'DB',
    responsibility: 'Stores data',
    row: 2,
    col: 0,
  })

  removeLayer(project, 0) // remove 'UI'

  assert.deepEqual(project.architecture?.layers, ['Service', 'Data'])
  assert.equal(dataElement.row, 1, 'element on row 2 must shift up to row 1 after row 0 is removed')
})

test('removeLayer clamps elements anchored on the removed last row', () => {
  const project = emptyProject()
  setArchitectureType(project, 'custom')
  addLayer(project, 'Only')
  const element = createArchitectureElement(project, {
    kind: 'functional',
    name: 'X',
    responsibility: 'Y',
    row: 0,
    col: 0,
  })

  removeLayer(project, 0)

  assert.equal(project.architecture?.layers.length, 0)
  assert.equal(element.row, 0, 'clamped to a safe row index even though no layers remain')
})

test('removeLayer throws for an out-of-range row index', () => {
  const project = emptyProject()
  setArchitectureType(project, 'custom')
  assert.throws(() => removeLayer(project, 5), /Layer row 5/)
})

test('checkArchitectureConflicts detects a circular dependency mechanically, without an LLM call', async () => {
  const project = emptyProject()
  setArchitectureType(project, 'custom')
  const a = createArchitectureElement(project, {
    kind: 'functional',
    name: 'A',
    responsibility: 'Does A',
    row: 0,
    col: 0,
  })
  const b = createArchitectureElement(project, {
    kind: 'functional',
    name: 'B',
    responsibility: 'Does B',
    row: 0,
    col: 1,
    interfaces: [],
  })
  updateArchitectureElement(project, a.id, { interfaces: [b.id] })
  updateArchitectureElement(project, b.id, { interfaces: [a.id] })

  const fake = new FakeLlmClient('NONE')
  const { conflicts } = await checkArchitectureConflicts(project, fake)

  const circular = conflicts.filter((c) => c.kind === 'circular-dependency')
  assert.equal(circular.length, 1)
  assert.deepEqual(new Set(circular[0].elementIds), new Set([a.id, b.id]))
})

test('checkArchitectureConflicts parses MISMATCH and OVERLAP lines from the LLM reply', async () => {
  const project = emptyProject()
  setArchitectureType(project, 'custom')
  createArchitectureElement(project, {
    kind: 'functional',
    name: 'A',
    responsibility: 'Handles users',
    row: 0,
    col: 0,
  })
  createArchitectureElement(project, {
    kind: 'functional',
    name: 'B',
    responsibility: 'Also handles users',
    row: 0,
    col: 1,
  })

  const fake = new FakeLlmClient(
    'MISMATCH: ARCH-001, ARCH-002: incompatible payload shape\n' +
      'OVERLAP: ARCH-001, ARCH-002: both manage user accounts',
  )
  const { conflicts } = await checkArchitectureConflicts(project, fake)

  assert.equal(conflicts.filter((c) => c.kind === 'interface-mismatch').length, 1)
  assert.equal(conflicts.filter((c) => c.kind === 'overlapping-responsibility').length, 1)
  assert.equal(project.architecture?.conflicts?.length, 2)
})

test('checkArchitectureConflicts ignores lines referencing unknown element ids', async () => {
  const project = emptyProject()
  setArchitectureType(project, 'custom')
  createArchitectureElement(project, {
    kind: 'functional',
    name: 'A',
    responsibility: 'Handles users',
    row: 0,
    col: 0,
  })

  const fake = new FakeLlmClient('MISMATCH: ARCH-001, ARCH-999: unknown id')
  const { conflicts } = await checkArchitectureConflicts(project, fake)

  assert.deepEqual(conflicts, [])
})

test('checkArchitectureConflicts on an empty element set still runs the mechanical check and skips the LLM call', async () => {
  const project = emptyProject()
  setArchitectureType(project, 'custom')

  const fake = new FakeLlmClient('NONE')
  const { conflicts } = await checkArchitectureConflicts(project, fake)

  assert.deepEqual(conflicts, [])
  assert.equal(fake.receivedMessages.length, 0)
})

test('checkArchitectureConflicts throws when no architecture exists yet', async () => {
  const project = emptyProject()
  const fake = new FakeLlmClient('NONE')
  await assert.rejects(() => checkArchitectureConflicts(project, fake), /architecture/i)
})

test('autoConfigureAndAllocate creates modules, wires interfaces, and allocates requirements from the LLM reply', async () => {
  const project = emptyProject()
  setArchitectureType(project, 'web-app') // ['UI', 'Service', 'Data']
  const r1 = createRequirementFromForm(project, { text: 'The system shall render a login form' })
  const r2 = createRequirementFromForm(project, { text: 'The system shall authenticate users' })
  const r3 = createRequirementFromForm(project, { text: 'The system shall charge cards via Stripe' })

  const fake = new FakeLlmClient(
    'MODULE: functional|UI|Login UI|Renders the login form\n' +
      'MODULE: service|Service|Auth Service|Authenticates users\n' +
      'MODULE: external|NONE|Stripe|Third-party payment processor\n' +
      `ALLOCATE: ${r1.id}|Login UI\n` +
      `ALLOCATE: ${r2.id}|Auth Service\n` +
      `ALLOCATE: ${r3.id}|Stripe\n` +
      'INTERFACE: Login UI|Auth Service\n' +
      'INTERFACE: Auth Service|Stripe',
  )

  const result = await autoConfigureAndAllocate(project, fake)

  assert.equal(result.createdElements.length, 3)
  const loginUi = project.architecture?.elements.find((e) => e.name === 'Login UI')
  const authService = project.architecture?.elements.find((e) => e.name === 'Auth Service')
  const stripe = project.architecture?.elements.find((e) => e.name === 'Stripe')
  assert.equal(loginUi?.row, 0, 'UI layer resolves to row 0')
  assert.equal(authService?.row, 1, 'Service layer resolves to row 1')
  assert.equal(stripe?.row, EXTERNAL_CONTEXT_ROW, 'external module is placed on the reserved context row')
  assert.deepEqual(loginUi?.interfaces, [authService?.id])
  assert.deepEqual(authService?.interfaces, [stripe?.id])

  assert.deepEqual(project.requirements.find((r) => r.id === r1.id)?.architectureElements, [loginUi?.id])
  assert.deepEqual(project.requirements.find((r) => r.id === r2.id)?.architectureElements, [authService?.id])
  assert.deepEqual(project.requirements.find((r) => r.id === r3.id)?.architectureElements, [stripe?.id])
  assert.deepEqual(result.unallocatedRequirementIds, [])
})

test('autoConfigureAndAllocate never includes imported code content in its LLM call (REQ-058)', async () => {
  const project = emptyProject()
  project.projectMode = 'import'
  project.importedCode = {
    files: [{ path: 'src/legacy-login.ts', content: 'DO_NOT_LEAK_THIS_INTO_THE_PROMPT_TOKEN' }],
    importedAt: new Date().toISOString(),
  }
  setArchitectureType(project, 'web-app')
  createRequirementFromForm(project, { text: 'The system shall render a login form' })

  const fake = new FakeLlmClient('MODULE: functional|UI|Login UI|Renders the login form')
  await autoConfigureAndAllocate(project, fake)

  assert.equal(fake.receivedMessages.length, 1)
  for (const message of fake.receivedMessages[0]) {
    assert.doesNotMatch(message.content, /DO_NOT_LEAK_THIS_INTO_THE_PROMPT_TOKEN/)
    assert.doesNotMatch(message.content, /legacy-login\.ts/)
  }
})

test('autoConfigureAndAllocate only fills gaps: existing elements and already-allocated requirements are untouched', async () => {
  const project = emptyProject()
  setArchitectureType(project, 'custom')
  addLayer(project, 'Core')
  const existing = createArchitectureElement(project, {
    kind: 'functional',
    name: 'Existing Module',
    responsibility: 'Already here',
    row: 0,
    col: 0,
  })
  const allocated = createRequirementFromForm(project, { text: 'The system shall already be allocated' })
  reassignArchitectureElement(project, allocated.id, existing.id)
  const gap = createRequirementFromForm(project, { text: 'The system shall do something new' })

  const fake = new FakeLlmClient(
    'MODULE: functional|Core|New Module|Handles the new thing\n' + `ALLOCATE: ${gap.id}|New Module`,
  )

  await autoConfigureAndAllocate(project, fake)

  assert.equal(project.architecture?.elements.length, 2, 'existing element is kept, one new element added')
  assert.deepEqual(
    project.requirements.find((r) => r.id === allocated.id)?.architectureElements,
    [existing.id],
    'already-allocated requirement must not be reassigned',
  )
  assert.equal(fake.receivedMessages[0][1].content.includes(allocated.id), false, 'already-allocated requirement is not sent to the LLM')
})

test('autoConfigureAndAllocate reports requirements the LLM reply never allocated', async () => {
  const project = emptyProject()
  setArchitectureType(project, 'custom')
  addLayer(project, 'Core')
  const r1 = createRequirementFromForm(project, { text: 'The system shall do the thing' })

  const fake = new FakeLlmClient('MODULE: functional|Core|Some Module|Does the thing')

  const result = await autoConfigureAndAllocate(project, fake)

  assert.deepEqual(result.unallocatedRequirementIds, [r1.id])
  assert.deepEqual(project.requirements[0].architectureElements, [])
})

test('autoConfigureAndAllocate skips a MODULE line naming an unrecognised layer rather than guessing a row', async () => {
  const project = emptyProject()
  setArchitectureType(project, 'custom')
  addLayer(project, 'Core')
  const r1 = createRequirementFromForm(project, { text: 'The system shall do the thing' })

  const fake = new FakeLlmClient(
    'MODULE: functional|NotARealLayer|Some Module|Does the thing\n' + `ALLOCATE: ${r1.id}|Some Module`,
  )

  const result = await autoConfigureAndAllocate(project, fake)

  assert.equal(result.createdElements.length, 0)
  assert.deepEqual(result.unallocatedRequirementIds, [r1.id])
})

test('autoConfigureAndAllocate does nothing and skips the LLM call when there are no unallocated requirements', async () => {
  const project = emptyProject()
  setArchitectureType(project, 'custom')

  const fake = new FakeLlmClient('NONE')
  const result = await autoConfigureAndAllocate(project, fake)

  assert.deepEqual(result, { createdElements: [], allocatedRequirementIds: [], unallocatedRequirementIds: [] })
  assert.equal(fake.receivedMessages.length, 0)
})

test('autoConfigureAndAllocate throws when no architecture exists yet', async () => {
  const project = emptyProject()
  createRequirementFromForm(project, { text: 'The system shall do the thing' })
  const fake = new FakeLlmClient('NONE')
  await assert.rejects(() => autoConfigureAndAllocate(project, fake), /architecture/i)
})

test('autoAllocateHeuristic allocates a requirement onto the element whose name/responsibility it overlaps most with', () => {
  const project = emptyProject()
  setArchitectureType(project, 'custom')
  addLayer(project, 'Core')
  const login = createArchitectureElement(project, {
    kind: 'functional',
    name: 'Login UI',
    responsibility: 'Renders the login form and handles user authentication',
    row: 0,
    col: 0,
  })
  const payments = createArchitectureElement(project, {
    kind: 'external',
    name: 'Stripe',
    responsibility: 'Third-party payment card processor',
    row: -1,
    col: 0,
  })
  const r1 = createRequirementFromForm(project, {
    text: 'The system shall render a login form for authentication',
  })
  const r2 = createRequirementFromForm(project, { text: 'The system shall charge cards via a payment processor' })

  const result = autoAllocateHeuristic(project)

  assert.deepEqual(result.unallocatedRequirementIds, [])
  assert.deepEqual(project.requirements.find((r) => r.id === r1.id)?.architectureElements, [login.id])
  assert.deepEqual(project.requirements.find((r) => r.id === r2.id)?.architectureElements, [payments.id])
})

test('autoAllocateHeuristic leaves a requirement unallocated when nothing scores above the minimum threshold', () => {
  const project = emptyProject()
  setArchitectureType(project, 'custom')
  addLayer(project, 'Core')
  createArchitectureElement(project, {
    kind: 'functional',
    name: 'Login UI',
    responsibility: 'Renders the login form',
    row: 0,
    col: 0,
  })
  const r1 = createRequirementFromForm(project, { text: 'Completely unrelated widget frobnicator behaviour' })

  const result = autoAllocateHeuristic(project)

  assert.deepEqual(result.unallocatedRequirementIds, [r1.id])
  assert.deepEqual(project.requirements[0].architectureElements, [])
})

test('autoAllocateHeuristic never creates elements and throws when none exist yet', () => {
  const project = emptyProject()
  setArchitectureType(project, 'custom')
  assert.throws(() => autoAllocateHeuristic(project), /architecture element/i)
})

test('autoAllocateHeuristic only touches unallocated requirements, leaving existing allocations untouched', () => {
  const project = emptyProject()
  setArchitectureType(project, 'custom')
  addLayer(project, 'Core')
  const elementA = createArchitectureElement(project, {
    kind: 'functional',
    name: 'Module A',
    responsibility: 'Handles login',
    row: 0,
    col: 0,
  })
  const elementB = createArchitectureElement(project, {
    kind: 'functional',
    name: 'Module B',
    responsibility: 'Handles login',
    row: 0,
    col: 1,
  })
  const allocated = createRequirementFromForm(project, { text: 'The system shall handle login' })
  reassignArchitectureElement(project, allocated.id, elementB.id)

  autoAllocateHeuristic(project)

  assert.deepEqual(
    project.requirements.find((r) => r.id === allocated.id)?.architectureElements,
    [elementB.id],
    'already-allocated requirement must not be reassigned to the higher-scoring element A',
  )
})

test('autoAllocateLlm allocates onto existing elements only, never creating new ones', async () => {
  const project = emptyProject()
  setArchitectureType(project, 'web-app')
  const existing = createArchitectureElement(project, {
    kind: 'functional',
    name: 'Login UI',
    responsibility: 'Renders the login form',
    row: 0,
    col: 0,
  })
  const r1 = createRequirementFromForm(project, { text: 'The system shall render a login form' })

  const fake = new FakeLlmClient(`ALLOCATE: ${r1.id}|Login UI`)
  const result = await autoAllocateLlm(project, fake)

  assert.equal(project.architecture?.elements.length, 1, 'no new element was created')
  assert.deepEqual(result.allocatedRequirementIds, [r1.id])
  assert.deepEqual(project.requirements.find((r) => r.id === r1.id)?.architectureElements, [existing.id])
})

test('autoAllocateLlm reports requirements the LLM reply never allocated', async () => {
  const project = emptyProject()
  setArchitectureType(project, 'web-app')
  createArchitectureElement(project, {
    kind: 'functional',
    name: 'Login UI',
    responsibility: 'Renders the login form',
    row: 0,
    col: 0,
  })
  const r1 = createRequirementFromForm(project, { text: 'The system shall do something unrelated' })

  const fake = new FakeLlmClient('NONE')
  const result = await autoAllocateLlm(project, fake)

  assert.deepEqual(result.unallocatedRequirementIds, [r1.id])
})

test('autoAllocateLlm throws when no architecture elements exist yet', async () => {
  const project = emptyProject()
  setArchitectureType(project, 'web-app')
  createRequirementFromForm(project, { text: 'The system shall do the thing' })
  const fake = new FakeLlmClient('NONE')
  await assert.rejects(() => autoAllocateLlm(project, fake), /architecture element/i)
})

test('autoAllocateLlm does nothing and skips the LLM call when there are no unallocated requirements', async () => {
  const project = emptyProject()
  setArchitectureType(project, 'web-app')
  createArchitectureElement(project, {
    kind: 'functional',
    name: 'Login UI',
    responsibility: 'Renders the login form',
    row: 0,
    col: 0,
  })

  const fake = new FakeLlmClient('NONE')
  const result = await autoAllocateLlm(project, fake)

  assert.deepEqual(result, { allocatedRequirementIds: [], unallocatedRequirementIds: [] })
  assert.equal(fake.receivedMessages.length, 0)
})

test('autoAllocateLlm batches a large unallocated set into multiple smaller LLM calls', async () => {
  const project = emptyProject()
  setArchitectureType(project, 'web-app')
  createArchitectureElement(project, {
    kind: 'functional',
    name: 'Login UI',
    responsibility: 'Renders the login form',
    row: 0,
    col: 0,
  })
  // 25 requirements > the 20-per-batch size, so this must take 2 LLM calls.
  const created: Requirement[] = []
  for (let i = 0; i < 25; i++) {
    created.push(createRequirementFromForm(project, { text: `The system shall do thing number ${i}` }))
  }

  const firstBatchAllocations = created
    .slice(0, 20)
    .map((r) => `ALLOCATE: ${r.id}|Login UI`)
    .join('\n')
  const secondBatchAllocations = created
    .slice(20)
    .map((r) => `ALLOCATE: ${r.id}|Login UI`)
    .join('\n')
  const fake = new MultiReplyFakeLlmClient([firstBatchAllocations, secondBatchAllocations])

  const result = await autoAllocateLlm(project, fake)

  assert.equal(fake.receivedMessages.length, 2, 'must make one LLM call per batch, not one call for everything')
  assert.equal(result.allocatedRequirementIds.length, 25)
  assert.deepEqual(result.unallocatedRequirementIds, [])
  for (const r of created) {
    assert.deepEqual(project.requirements.find((req) => req.id === r.id)?.architectureElements, ['ARCH-001'])
  }
})

test('autoAllocateLlm accumulates usage across batches', async () => {
  const project = emptyProject()
  setArchitectureType(project, 'web-app')
  createArchitectureElement(project, {
    kind: 'functional',
    name: 'Login UI',
    responsibility: 'Renders the login form',
    row: 0,
    col: 0,
  })
  const created: Requirement[] = []
  for (let i = 0; i < 21; i++) {
    created.push(createRequirementFromForm(project, { text: `The system shall do thing number ${i}` }))
  }

  const fake = new MultiReplyFakeLlmClient(['NONE', 'NONE'])
  const result = await autoAllocateLlm(project, fake)

  assert.equal(fake.receivedMessages.length, 2)
  assert.deepEqual(result.usage, { promptTokens: 20, completionTokens: 10, totalTokens: 30 })
})

test('autoAllocateLlm includes a requirement\'s allocationRationale in the prompt sent to the LLM', async () => {
  const project = emptyProject()
  setArchitectureType(project, 'web-app')
  createArchitectureElement(project, {
    kind: 'functional',
    name: 'Login UI',
    responsibility: 'Renders the login form',
    row: 0,
    col: 0,
  })
  const r1 = createRequirementFromForm(project, { text: 'The system shall emit telemetry events' })
  r1.allocationRationale = 'goes in the Telemetry module, not Logging'

  const fake = new FakeLlmClient('NONE')
  await autoAllocateLlm(project, fake)

  assert.match(fake.receivedMessages[0][1].content, /goes in the Telemetry module, not Logging/)
})

test('autoAllocateHeuristic folds allocationRationale keywords into its scoring', () => {
  const project = emptyProject()
  setArchitectureType(project, 'custom')
  addLayer(project, 'Core')
  const generic = createArchitectureElement(project, {
    kind: 'functional',
    name: 'Generic Module',
    responsibility: 'Does generic things',
    row: 0,
    col: 0,
  })
  const telemetry = createArchitectureElement(project, {
    kind: 'functional',
    name: 'Telemetry Module',
    responsibility: 'Collects and forwards telemetry events',
    row: 0,
    col: 1,
  })
  // Requirement text alone doesn't clearly favour either module; the
  // rationale is what should tip the score toward Telemetry.
  const r1 = createRequirementFromForm(project, { text: 'The system shall do a thing' })
  r1.allocationRationale = 'telemetry events forwarding'

  const result = autoAllocateHeuristic(project)

  assert.deepEqual(result.unallocatedRequirementIds, [])
  assert.deepEqual(project.requirements.find((r) => r.id === r1.id)?.architectureElements, [telemetry.id])
  assert.notDeepEqual(project.requirements.find((r) => r.id === r1.id)?.architectureElements, [generic.id])
})

function twoConnectedElements(project: Project) {
  setArchitectureType(project, 'custom')
  addLayer(project, 'Core')
  const from = createArchitectureElement(project, {
    kind: 'functional',
    name: 'Order Service',
    responsibility: 'Manages order lifecycle',
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

test('defineInterfaceContract parses OPERATION lines from the LLM reply into a persisted contract', async () => {
  const project = emptyProject()
  const { from, to } = twoConnectedElements(project)
  const llmClient = new FakeLlmClient(
    'OPERATION: chargeCard|Charges the customer|orderId: string, amount: number|receiptId: string|CardDeclined\n' +
      'OPERATION: refund|Refunds a charge|receiptId: string|NONE|NONE',
  )

  const result = await defineInterfaceContract(project, llmClient, from.id, to.id)

  assert.equal(result.contract.fromId, from.id)
  assert.equal(result.contract.toId, to.id)
  assert.equal(result.contract.status, 'defined')
  assert.equal(result.contract.operations.length, 2)
  assert.equal(result.contract.operations[0].name, 'chargeCard')
  assert.equal(result.contract.operations[0].errors, 'CardDeclined')
  assert.equal(result.contract.operations[1].errors, '')
  assert.deepEqual(project.architecture?.interfaceContracts, [result.contract])
})

test('defineInterfaceContract treats a NONE reply as zero operations, not an error', async () => {
  const project = emptyProject()
  const { from, to } = twoConnectedElements(project)
  const llmClient = new FakeLlmClient('NONE')

  const result = await defineInterfaceContract(project, llmClient, from.id, to.id)

  assert.deepEqual(result.contract.operations, [])
  assert.equal(result.contract.status, 'defined')
})

test('defineInterfaceContract replaces any existing contract for the same pair rather than duplicating it', async () => {
  const project = emptyProject()
  const { from, to } = twoConnectedElements(project)
  await defineInterfaceContract(project, new FakeLlmClient('OPERATION: a|d|r|s|NONE'), from.id, to.id)

  await defineInterfaceContract(project, new FakeLlmClient('OPERATION: b|d|r|s|NONE'), from.id, to.id)

  assert.equal(project.architecture?.interfaceContracts?.length, 1)
  assert.equal(project.architecture?.interfaceContracts?.[0].operations[0].name, 'b')
})

test('defineInterfaceContract throws when either element does not exist', async () => {
  const project = emptyProject()
  const { from } = twoConnectedElements(project)
  const llmClient = new FakeLlmClient('NONE')

  await assert.rejects(() => defineInterfaceContract(project, llmClient, from.id, 'ARCH-999'))
})

test('defineAllInterfaceContracts defines every connected pair that has no contract yet', async () => {
  const project = emptyProject()
  const { from, to } = twoConnectedElements(project)
  const third = createArchitectureElement(project, {
    kind: 'functional',
    name: 'Inventory Service',
    responsibility: 'Tracks stock levels',
    row: 0,
    col: 2,
  })
  acceptProposedInterface(project, to.id, third.id)
  const llmClient = new FakeLlmClient('OPERATION: op|d|r|s|NONE')

  const result = await defineAllInterfaceContracts(project, llmClient)

  assert.equal(result.contracts.length, 2)
  assert.equal(llmClient.receivedMessages.length, 2)
})

test('defineAllInterfaceContracts skips pairs that already have a defined contract (non-destructive re-run)', async () => {
  const project = emptyProject()
  const { from, to } = twoConnectedElements(project)
  await defineInterfaceContract(project, new FakeLlmClient('OPERATION: original|d|r|s|NONE'), from.id, to.id)

  const llmClient = new FakeLlmClient('OPERATION: shouldNotAppear|d|r|s|NONE')
  const result = await defineAllInterfaceContracts(project, llmClient)

  assert.equal(llmClient.receivedMessages.length, 0)
  assert.equal(result.contracts[0].operations[0].name, 'original')
})

test('checkInterfaces reports complete:true once every connected pair has a defined, non-empty contract', async () => {
  const project = emptyProject()
  const { from, to } = twoConnectedElements(project)
  await defineInterfaceContract(project, new FakeLlmClient('OPERATION: op|d|r|s|NONE'), from.id, to.id)

  const result = checkInterfaces(project)

  assert.equal(result.complete, true)
  assert.deepEqual(result.undefinedPairs, [])
})

test('checkInterfaces lists a connected pair as undefined when no contract has been defined for it', () => {
  const project = emptyProject()
  const { from, to } = twoConnectedElements(project)

  const result = checkInterfaces(project)

  assert.equal(result.complete, false)
  assert.equal(result.undefinedPairs.length, 1)
  assert.equal(result.undefinedPairs[0].fromId, from.id)
  assert.equal(result.undefinedPairs[0].toId, to.id)
})

test('checkInterfaces treats a defined contract with zero operations as still undefined', async () => {
  const project = emptyProject()
  const { from, to } = twoConnectedElements(project)
  await defineInterfaceContract(project, new FakeLlmClient('NONE'), from.id, to.id)

  const result = checkInterfaces(project)

  assert.equal(result.complete, false)
  assert.equal(result.undefinedPairs.length, 1)
})

test('checkInterfaces ignores elements with no connections at all', () => {
  const project = emptyProject()
  setArchitectureType(project, 'custom')
  addLayer(project, 'Core')
  createArchitectureElement(project, {
    kind: 'functional',
    name: 'Standalone Module',
    responsibility: 'Does its own thing',
    row: 0,
    col: 0,
  })

  const result = checkInterfaces(project)

  assert.equal(result.complete, true)
  assert.deepEqual(result.undefinedPairs, [])
})
