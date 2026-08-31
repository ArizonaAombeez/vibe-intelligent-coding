import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  setArchitectureType,
  createArchitectureElement,
  updateArchitectureElement,
  deleteArchitectureElement,
  pruneOrphanedInterfaceReferences,
  addLayer,
  removeLayer,
  checkArchitectureConflicts,
  autoConfigureAndAllocate,
  autoAllocateLlm,
  acceptProposedInterface,
  defineInterfaceDefinition,
  defineAllInterfaceDefinitions,
  deriveHarnessSpec,
  setInterfaceDefinition,
  checkInterfaces,
  connectedPairs,
  EXTERNAL_CONTEXT_ROW,
  createRequirementFromForm as createRequirementFromFormReal,
  reassignArchitectureElement,
  ensureHarnessElement,
  importArchitecturePart,
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
    schemaVersion: 2,
    id: 'proj-1',
    name: 'Test Project',
    projectMode: 'new',
    requirements: [],
  }
}

// Every project gets one auto-created kind:'harness' element (project
// harness feature). Tests that predate that concept assert on the
// functional/service/etc. elements only — filter it out here.
function nonHarnessElements(project: Project) {
  return (project.architecture?.elements ?? []).filter((e) => e.kind !== 'harness')
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
  assert.deepEqual(nonHarnessElements(project), [])
})

test('setArchitectureType auto-creates the single mandatory harness element', () => {
  const project = emptyProject()
  setArchitectureType(project, 'web-app')
  const harness = project.architecture?.elements.filter((e) => e.kind === 'harness') ?? []
  assert.equal(harness.length, 1)
  assert.equal(harness[0].id, 'ARCH-HARNESS')
  // Re-selecting must not create a second one.
  setArchitectureType(project, 'web-app')
  assert.equal((project.architecture?.elements ?? []).filter((e) => e.kind === 'harness').length, 1)
})

test('deleteArchitectureElement refuses to delete the harness', () => {
  const project = emptyProject()
  setArchitectureType(project, 'web-app')
  assert.throws(() => deleteArchitectureElement(project, 'ARCH-HARNESS'), /mandatory|cannot be deleted/i)
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

  assert.equal(nonHarnessElements(project).length, 1, 're-selecting the same type must not wipe elements')
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

  assert.equal(nonHarnessElements(project).length, 1)
  assert.deepEqual(nonHarnessElements(project)[0].interfaces, [], 'dangling interface reference must be cleared')
  assert.deepEqual(project.requirements[0].architectureElements, [], 'requirement must fall back to unallocated')
  assert.equal(api.id, 'ARCH-002', 'surviving element keeps its own id')
})

test('deleteArchitectureElement throws for an unknown element id', () => {
  const project = emptyProject()
  setArchitectureType(project, 'custom')
  assert.throws(() => deleteArchitectureElement(project, 'ARCH-999'), /ARCH-999/)
})

test('deleteArchitectureElement also removes the interface definition it participated in and every other element\'s copy (T4.1)', async () => {
  const project = emptyProject()
  setArchitectureType(project, 'custom')
  const engine = createArchitectureElement(project, {
    kind: 'functional',
    name: 'Game Engine',
    responsibility: 'Runs the game loop',
    row: 0,
    col: 0,
  })
  const repo = createArchitectureElement(project, {
    kind: 'service',
    name: 'State Repository',
    responsibility: 'Persists state',
    row: 1,
    col: 0,
    interfaces: [engine.id],
  })
  // Give the pair a real defined contract, and seed both sides' local copy.
  await defineInterfaceDefinition(
    project,
    new FakeLlmClient('OPERATION: save|persist state|state|ack|NONE'),
    engine.id,
    repo.id,
  )
  const defBefore = project.architecture!.interfaceDefinitions!.find((d) =>
    d.participants.some((p) => p.elementId === repo.id),
  )
  assert.ok(defBefore, 'contract exists before delete')
  assert.ok(
    project.architecture!.elements.find((e) => e.id === engine.id)!.elementInterfaces.length > 0,
    'engine has a local copy of the contract before delete',
  )

  deleteArchitectureElement(project, repo.id)

  assert.equal(
    project.architecture!.interfaceDefinitions!.some((d) => d.id === defBefore.id),
    false,
    'the definition naming the deleted element is gone',
  )
  assert.deepEqual(
    project.architecture!.elements.find((e) => e.id === engine.id)!.elementInterfaces,
    [],
    "the surviving element's local copy of that now-dead contract is cleared",
  )
})

test('pruneOrphanedInterfaceReferences is idempotent and only removes provably-dead refs (T4.2)', async () => {
  const project = emptyProject()
  setArchitectureType(project, 'custom')
  const a = createArchitectureElement(project, { kind: 'functional', name: 'A', responsibility: 'a', row: 0, col: 0 })
  const b = createArchitectureElement(project, {
    kind: 'service',
    name: 'B',
    responsibility: 'b',
    row: 1,
    col: 0,
    interfaces: [a.id],
  })
  await defineInterfaceDefinition(
    project,
    new FakeLlmClient('OPERATION: ping|ping|x|y|NONE'),
    a.id,
    b.id,
  )
  // Inject an orphan directly, as a stale save would carry it.
  project.architecture!.interfaceDefinitions!.push({
    id: 'IFACE-DEAD',
    name: 'A <-> Ghost',
    participants: [
      { elementId: a.id, role: 'both' },
      { elementId: 'ARCH-GHOST', role: 'both' },
    ],
    status: 'defined',
    updatedAt: new Date().toISOString(),
    operations: [],
  })
  project.architecture!.elements.find((e) => e.id === a.id)!.elementInterfaces.push({
    masterDefinitionId: 'IFACE-DEAD',
    role: 'both',
    aligned: true,
    operations: [],
  })
  project.architecture!.elements.find((e) => e.id === a.id)!.interfaces.push('ARCH-GHOST')

  const first = pruneOrphanedInterfaceReferences(project.architecture!)
  assert.deepEqual(first.removedDefinitionIds, ['IFACE-DEAD'])
  assert.equal(first.clearedElementInterfaceRefs.length, 1)
  assert.deepEqual(first.removedGraphEdges, [{ elementId: a.id, toId: 'ARCH-GHOST' }])
  // The real contract is untouched.
  assert.ok(project.architecture!.interfaceDefinitions!.some((d) => d.id !== 'IFACE-DEAD'))

  const second = pruneOrphanedInterfaceReferences(project.architecture!)
  assert.deepEqual(second.removedDefinitionIds, [])
  assert.equal(second.clearedElementInterfaceRefs.length, 0)
  assert.deepEqual(second.removedGraphEdges, [])
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

  assert.equal(nonHarnessElements(project).length, 2, 'existing element is kept, one new element added')
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

  assert.equal(nonHarnessElements(project).length, 1, 'no new element was created')
  assert.deepEqual(result.allocatedRequirementIds, [r1.id])
  assert.deepEqual(project.requirements.find((r) => r.id === r1.id)?.architectureElements, [existing.id])
})

test('autoAllocateLlm allocates an import-prefixed requirement id (IMP_REQ-NNN)', async () => {
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
  // Simulate an imported requirement: id carries the IMP_ prefix that
  // projectParts.importRequirementsFromPart stamps on.
  r1.id = `IMP_${r1.id}`

  const fake = new FakeLlmClient(`ALLOCATE: ${r1.id}|Login UI`)
  const result = await autoAllocateLlm(project, fake)

  assert.deepEqual(result.allocatedRequirementIds, [r1.id])
  assert.deepEqual(project.requirements.find((r) => r.id === r1.id)?.architectureElements, [existing.id])
})

test('autoAllocateLlm resolves a module name the LLM returned with different casing / trailing punctuation', async () => {
  const project = emptyProject()
  setArchitectureType(project, 'web-app')
  const existing = createArchitectureElement(project, {
    kind: 'functional',
    name: 'Game Engine',
    responsibility: 'Runs the game loop',
    row: 0,
    col: 0,
  })
  const r1 = createRequirementFromForm(project, { text: 'The system shall advance the game one tick' })

  const fake = new FakeLlmClient(`ALLOCATE: ${r1.id}|game engine.`)
  const result = await autoAllocateLlm(project, fake)

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

test('defineInterfaceDefinition parses OPERATION lines from the LLM reply into a persisted contract', async () => {
  const project = emptyProject()
  const { from, to } = twoConnectedElements(project)
  const llmClient = new FakeLlmClient(
    'OPERATION: chargeCard|Charges the customer|orderId: string, amount: number|receiptId: string|CardDeclined\n' +
      'OPERATION: refund|Refunds a charge|receiptId: string|NONE|NONE',
  )

  const result = await defineInterfaceDefinition(project, llmClient, from.id, to.id)

  assert.deepEqual(
    result.definition.participants.map((p) => p.elementId).sort(),
    [from.id, to.id].sort(),
  )
  assert.equal(result.definition.status, 'defined')
  assert.equal(result.definition.operations.length, 2)
  assert.equal(result.definition.operations[0].name, 'chargeCard')
  assert.equal(result.definition.operations[0].errors, 'CardDeclined')
  assert.equal(result.definition.operations[1].errors, '')
  assert.deepEqual(project.architecture?.interfaceDefinitions, [result.definition])
})

test('defineInterfaceDefinition treats a NONE reply as zero operations, not an error', async () => {
  const project = emptyProject()
  const { from, to } = twoConnectedElements(project)
  const llmClient = new FakeLlmClient('NONE')

  const result = await defineInterfaceDefinition(project, llmClient, from.id, to.id)

  assert.deepEqual(result.definition.operations, [])
  assert.equal(result.definition.status, 'defined')
})

test('defineInterfaceDefinition replaces any existing contract for the same pair rather than duplicating it', async () => {
  const project = emptyProject()
  const { from, to } = twoConnectedElements(project)
  await defineInterfaceDefinition(project, new FakeLlmClient('OPERATION: a|d|r|s|NONE'), from.id, to.id)

  await defineInterfaceDefinition(project, new FakeLlmClient('OPERATION: b|d|r|s|NONE'), from.id, to.id)

  assert.equal(project.architecture?.interfaceDefinitions?.length, 1)
  assert.equal(project.architecture?.interfaceDefinitions?.[0].operations[0].name, 'b')
})

test('defineInterfaceDefinition throws when either element does not exist', async () => {
  const project = emptyProject()
  const { from } = twoConnectedElements(project)
  const llmClient = new FakeLlmClient('NONE')

  await assert.rejects(() => defineInterfaceDefinition(project, llmClient, from.id, 'ARCH-999'))
})

test('setInterfaceDefinition persists a manually-authored operation list without any LLM call', () => {
  const project = emptyProject()
  const { from, to } = twoConnectedElements(project)

  const definition = setInterfaceDefinition(
    project,
    undefined,
    'Order interface',
    [
      { elementId: from.id, role: 'both' },
      { elementId: to.id, role: 'both' },
    ],
    [
      {
        name: 'submitOrder',
        description: 'Submits a new order',
        request: 'orderId: string',
        response: 'confirmationId: string',
        errors: '',
        range: '0-999',
        resolution: '1',
        unit: 'count',
        updateFrequency: 'on user action',
      },
    ],
  )

  assert.equal(definition.status, 'defined')
  assert.equal(project.architecture?.interfaceDefinitions?.[0].operations[0].name, 'submitOrder')
})

test('setInterfaceDefinition replaces any existing definition with the same id rather than duplicating it', () => {
  const project = emptyProject()
  const { from, to } = twoConnectedElements(project)
  const participants: Array<{ elementId: string; role: 'both' }> = [
    { elementId: from.id, role: 'both' },
    { elementId: to.id, role: 'both' },
  ]
  const first = setInterfaceDefinition(project, undefined, 'Order interface', participants, [
    { name: 'a', description: 'd', request: 'r', response: 's', errors: '' },
  ])

  setInterfaceDefinition(project, first.id, 'Order interface', participants, [
    { name: 'b', description: 'd', request: 'r', response: 's', errors: '' },
  ])

  assert.equal(project.architecture?.interfaceDefinitions?.length, 1)
  assert.equal(project.architecture?.interfaceDefinitions?.[0].operations[0].name, 'b')
})

test('setInterfaceDefinition throws when a participant element does not exist', () => {
  const project = emptyProject()
  const { from } = twoConnectedElements(project)

  assert.throws(() =>
    setInterfaceDefinition(
      project,
      undefined,
      'Bad interface',
      [
        { elementId: from.id, role: 'both' },
        { elementId: 'ARCH-999', role: 'both' },
      ],
      [],
    ),
  )
})

test('setInterfaceDefinition throws when the participants are not connected', () => {
  const project = emptyProject()
  setArchitectureType(project, 'custom')
  addLayer(project, 'Core')
  const a = createArchitectureElement(project, {
    kind: 'functional',
    name: 'A',
    responsibility: 'x',
    row: 0,
    col: 0,
  })
  const b = createArchitectureElement(project, {
    kind: 'functional',
    name: 'B',
    responsibility: 'y',
    row: 0,
    col: 1,
  })

  assert.throws(() =>
    setInterfaceDefinition(
      project,
      undefined,
      'Unconnected interface',
      [
        { elementId: a.id, role: 'both' },
        { elementId: b.id, role: 'both' },
      ],
      [],
    ),
  )
})

test('defineAllInterfaceDefinitions defines every connected pair that has no contract yet', async () => {
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

  const result = await defineAllInterfaceDefinitions(project, llmClient)

  assert.equal(result.definitions.length, 2)
  assert.equal(llmClient.receivedMessages.length, 2)
})

test('defineAllInterfaceDefinitions skips pairs that already have a defined contract (non-destructive re-run)', async () => {
  const project = emptyProject()
  const { from, to } = twoConnectedElements(project)
  await defineInterfaceDefinition(project, new FakeLlmClient('OPERATION: original|d|r|s|NONE'), from.id, to.id)

  const llmClient = new FakeLlmClient('OPERATION: shouldNotAppear|d|r|s|NONE')
  const result = await defineAllInterfaceDefinitions(project, llmClient)

  assert.equal(llmClient.receivedMessages.length, 0)
  assert.equal(result.definitions[0].operations[0].name, 'original')
})

test('defineAllInterfaceDefinitions with force:true re-asks the Architect for every connected pair, overwriting already-defined contracts', async () => {
  const project = emptyProject()
  const { from, to } = twoConnectedElements(project)
  await defineInterfaceDefinition(project, new FakeLlmClient('OPERATION: original|d|r|s|NONE'), from.id, to.id)

  const llmClient = new FakeLlmClient('OPERATION: replaced|d|r|s|NONE')
  const result = await defineAllInterfaceDefinitions(project, llmClient, undefined, true)

  assert.equal(llmClient.receivedMessages.length, 1)
  assert.equal(result.definitions[0].operations[0].name, 'replaced')
})

test('checkInterfaces reports complete:true once every connected pair has a defined, non-empty contract with full data-contract detail', async () => {
  const project = emptyProject()
  const { from, to } = twoConnectedElements(project)
  await defineInterfaceDefinition(
    project,
    new FakeLlmClient('OPERATION: op|d|r|s|NONE|0-100|1|percent|every 100ms'),
    from.id,
    to.id,
  )

  const result = checkInterfaces(project)

  assert.equal(result.complete, true)
  assert.deepEqual(result.undefinedPairs, [])
  assert.deepEqual(result.incompleteOperations, [])
})

test('checkInterfaces flags an operation missing range/resolution/unit/update-frequency as incomplete, even though its contract is defined', async () => {
  const project = emptyProject()
  const { from, to } = twoConnectedElements(project)
  await defineInterfaceDefinition(project, new FakeLlmClient('OPERATION: op|d|r|s|NONE'), from.id, to.id)

  const result = checkInterfaces(project)

  assert.equal(result.complete, false)
  assert.deepEqual(result.undefinedPairs, [])
  assert.equal(result.incompleteOperations.length, 1)
  assert.equal(result.incompleteOperations[0].operationName, 'op')
  assert.deepEqual(result.incompleteOperations[0].missingFields, [
    'range',
    'resolution',
    'unit',
    'update frequency (or driven-directly)',
  ])
})

test('checkInterfaces treats DRIVEN as satisfying the update-frequency requirement without needing updateFrequency text', async () => {
  const project = emptyProject()
  const { from, to } = twoConnectedElements(project)
  await defineInterfaceDefinition(
    project,
    new FakeLlmClient('OPERATION: op|d|r|s|NONE|0-1|1|bool|DRIVEN'),
    from.id,
    to.id,
  )

  const result = checkInterfaces(project)

  assert.deepEqual(result.incompleteOperations, [])
})

test('checkInterfaces treats an explicit NONE reply for range/resolution/unit as N/A, not a missing-field gap, for a non-measured operation', async () => {
  const project = emptyProject()
  const { from, to } = twoConnectedElements(project)
  await defineInterfaceDefinition(
    project,
    new FakeLlmClient('OPERATION: login|Authenticates a user|creds|token|InvalidCredentials|NONE|NONE|NONE|on user action'),
    from.id,
    to.id,
  )

  const result = checkInterfaces(project)

  assert.deepEqual(result.incompleteOperations, [])
  assert.equal(result.complete, true)
  const op = project.architecture?.interfaceDefinitions?.[0].operations[0]
  assert.equal(op?.range, 'N/A')
  assert.equal(op?.resolution, 'N/A')
  assert.equal(op?.unit, 'N/A')
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
  await defineInterfaceDefinition(project, new FakeLlmClient('NONE'), from.id, to.id)

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

// Real-world corruption this guards against: an element's own
// elementInterfaces entry can point at a masterDefinitionId with no
// matching InterfaceDefinition at all (e.g. a historical "IFACE-undefined"
// id from nextInterfaceId's old unguarded seq+1, or a definition deleted
// out from under a participant). aligned:true alone doesn't catch this —
// alignment only tracks staleness against a master that DOES exist — so
// checkInterfaces needs a distinct dangling-reference check.
test('checkInterfaces flags an elementInterfaces entry whose masterDefinitionId has no matching definition', () => {
  const project = emptyProject()
  const { from } = twoConnectedElements(project)
  from.elementInterfaces.push({
    masterDefinitionId: 'IFACE-undefined',
    role: 'both',
    operations: [{ name: 'op', description: 'x', request: 'x', response: 'x', errors: '' }],
    aligned: true,
  })

  const result = checkInterfaces(project)

  assert.equal(result.complete, false)
  assert.equal(result.danglingElementInterfaces.length, 1)
  assert.equal(result.danglingElementInterfaces[0].elementId, from.id)
  assert.equal(result.danglingElementInterfaces[0].masterDefinitionId, 'IFACE-undefined')
  // A dangling entry is a distinct problem from misalignment — aligned:true
  // above must not also surface it as (or instead of) a misaligned entry,
  // since there's no real master to reconcile against.
  assert.deepEqual(result.misalignedElements, [])
})

// nextInterfaceId's own defensive fallback (architecture.ts): a corrupted
// or missing nextInterfaceSeq must not keep producing bad ids forever —
// this proves defineInterfaceDefinition (which calls nextInterfaceId
// internally) self-heals from a bad counter instead of generating another
// "IFACE-undefined"/"IFACE-NaN".
test('defineInterfaceDefinition recovers a real id when nextInterfaceSeq is corrupted', async () => {
  const project = emptyProject()
  const { from, to } = twoConnectedElements(project)
  ;(project.architecture as unknown as { nextInterfaceSeq: unknown }).nextInterfaceSeq = undefined

  const result = await defineInterfaceDefinition(project, new FakeLlmClient('NONE'), from.id, to.id)

  assert.equal(result.definition.id.includes('undefined'), false)
  assert.equal(result.definition.id.includes('NaN'), false)
  assert.match(result.definition.id, /^IFACE-\d+$/)
})

// ---------------------------------------------------------------------------
// Project harness feature: DECLARE lines, deriveHarnessSpec, harness gating
// ---------------------------------------------------------------------------

test('defineInterfaceDefinition parses DECLARE lines into platform-neutral declarations', async () => {
  const project = emptyProject()
  const { from, to } = twoConnectedElements(project)
  const llmClient = new FakeLlmClient(
    'OPERATION: chargeCard|Charges the customer|orderId: string|receiptId: string|NONE\n' +
      `DECLARE: ${from.id}|manages order lifecycle|submitOrder;cancelOrder|orders;orderTotals|${to.id}\n` +
      `DECLARE: ${to.id}|processes payments|chargeCard|receipts|NONE`,
  )

  const result = await defineInterfaceDefinition(project, llmClient, from.id, to.id)

  const decls = result.definition.declarations ?? []
  assert.equal(decls.length, 2)
  const fromDecl = decls.find((d) => d.elementId === from.id)!
  assert.equal(fromDecl.does, 'manages order lifecycle')
  assert.deepEqual(fromDecl.exposes, ['submitOrder', 'cancelOrder'])
  assert.deepEqual(fromDecl.owns, ['orders', 'orderTotals'])
  assert.deepEqual(fromDecl.visibleTo, [to.id])
  const toDecl = decls.find((d) => d.elementId === to.id)!
  assert.deepEqual(toDecl.visibleTo, ['none'])
})

test('DECLARE lines are parsed even when OPERATION reply is NONE', async () => {
  const project = emptyProject()
  const { from, to } = twoConnectedElements(project)
  const llmClient = new FakeLlmClient(
    'NONE\n' +
      `DECLARE: ${from.id}|does A|callA|dataA|ALL\n` +
      `DECLARE: ${to.id}|does B|callB|dataB|ALL`,
  )

  const result = await defineInterfaceDefinition(project, llmClient, from.id, to.id)

  assert.deepEqual(result.definition.operations, [])
  assert.equal((result.definition.declarations ?? []).length, 2)
  assert.deepEqual((result.definition.declarations ?? [])[0].visibleTo, ['all'])
})

test('checkInterfaces reports non-harness elements with no declaration, advisory only', async () => {
  const project = emptyProject()
  const { from, to } = twoConnectedElements(project)
  // Define with declarations only for `from`.
  await defineInterfaceDefinition(
    project,
    new FakeLlmClient('NONE\n' + `DECLARE: ${from.id}|does A|callA|dataA|NONE`),
    from.id,
    to.id,
  )

  const result = checkInterfaces(project)
  assert.deepEqual(result.missingDeclarations, [to.id])
  // Advisory: does not by itself make the check incomplete-for-blocking
  // reasons beyond the pre-existing undefinedPairs logic.
})

test('deriveHarnessSpec stores a spec on the harness element and wires it to every other element', async () => {
  const project = emptyProject()
  const { from, to } = twoConnectedElements(project)
  await defineInterfaceDefinition(
    project,
    new FakeLlmClient(
      'OPERATION: chargeCard|Charges|orderId|receiptId|NONE\n' +
        `DECLARE: ${from.id}|orders|submitOrder|orders|${to.id}\n` +
        `DECLARE: ${to.id}|payments|chargeCard|receipts|NONE`,
    ),
    from.id,
    to.id,
  )
  const ifaceId = project.architecture!.interfaceDefinitions![0].id

  const platform = {
    id: 'web' as const,
    label: 'Web App',
    entryPointHint: 'index.html + main.tsx',
    wiringHint: 'ES module imports',
    lifecycleHint: 'start only',
    builtIn: true,
  }
  const reply =
    'CHECK: entry-point|applies|index.html loads src/main.tsx which mounts the app\n' +
    'CHECK: element-instantiation|applies|main.tsx constructs each element in order\n' +
    'CHECK: lifecycle-stop|not-applicable|the web page has no explicit stop phase\n' +
    `LINK: ${ifaceId}|Order Service is constructed with a reference to Payment Service\n` +
    'NARRATIVE: index.html loads main.tsx which builds Payment Service then Order Service and calls start().\n\n'
  const result = await deriveHarnessSpec(project, new FakeLlmClient(reply), platform)

  const harness = project.architecture!.elements.find((e) => e.kind === 'harness')!
  assert.ok(harness.harnessSpec)
  assert.equal(harness.harnessSpec!.derivedForPlatform, 'web')
  // One checklist item per default key, missing ones filled as 'unknown'.
  assert.equal(harness.harnessSpec!.checklist.length, 8)
  assert.equal(harness.harnessSpec!.checklist.find((c) => c.key === 'entry-point')!.status, 'applies')
  assert.equal(harness.harnessSpec!.checklist.find((c) => c.key === 'lifecycle-stop')!.status, 'not-applicable')
  assert.equal(harness.harnessSpec!.checklist.find((c) => c.key === 'config-load')!.status, 'unknown')
  assert.equal(harness.harnessSpec!.linkRealisations.length, 1)
  assert.equal(harness.harnessSpec!.linkRealisations[0].masterDefinitionId, ifaceId)
  assert.match(harness.harnessSpec!.narrative, /main\.tsx/)
  // Wired to every non-harness element for the grid.
  assert.deepEqual(harness.interfaces.sort(), [from.id, to.id].sort())
})

test('connectedPairs skips edges touching the harness', async () => {
  const project = emptyProject()
  const { from, to } = twoConnectedElements(project)
  const platform = {
    id: 'web' as const,
    label: 'Web App',
    entryPointHint: 'x',
    wiringHint: 'y',
    lifecycleHint: 'z',
    builtIn: true,
  }
  await deriveHarnessSpec(project, new FakeLlmClient('NARRATIVE: n\n\n'), platform)
  // Harness is now wired to from+to, but connectedPairs must still only
  // return the real from<->to pair.
  const pairs = connectedPairs(project.architecture!.elements)
  assert.equal(pairs.length, 1)
  assert.deepEqual([pairs[0].fromId, pairs[0].toId].sort(), [from.id, to.id].sort())
})

test('importArchitecturePart drops the source project\'s harness — never a second harness', () => {
  const project = emptyProject()
  setArchitectureType(project, 'web-app') // auto-creates ARCH-HARNESS
  assert.equal((project.architecture?.elements ?? []).filter((e) => e.kind === 'harness').length, 1)

  const imported = importArchitecturePart(project, {
    architectureType: 'web-app',
    architecture: {
      layers: ['Imported Layer'],
      nextElementSeq: 2,
      nextInterfaceSeq: 1,
      elements: [
        { id: 'ARCH-HARNESS', kind: 'harness', name: 'Harness', responsibility: 'wires it', row: -2, col: 0, rowSpan: 1, colSpan: 1, interfaces: ['ARCH-001'], elementInterfaces: [] },
        { id: 'ARCH-001', kind: 'functional', name: 'Imported UI', responsibility: 'renders', row: 0, col: 0, rowSpan: 1, colSpan: 1, interfaces: [], elementInterfaces: [] },
      ],
    },
  })

  const harnesses = (project.architecture?.elements ?? []).filter((e) => e.kind === 'harness')
  assert.equal(harnesses.length, 1, 'still exactly one harness after import')
  assert.equal(harnesses[0].id, 'ARCH-HARNESS', 'the project\'s own harness is kept')
  assert.equal(imported.length, 1, 'only the non-harness element was imported')
  assert.equal(imported[0].kind, 'functional')
})

test('ensureHarnessElement self-heals a project that already has two harnesses', () => {
  const project = emptyProject()
  setArchitectureType(project, 'web-app')
  // Simulate the pre-fix broken state: a second harness with an IMP_ id.
  project.architecture!.elements.push({
    id: 'IMP_ARCH-HARNESS',
    kind: 'harness',
    name: 'Harness',
    responsibility: 'imported dup',
    row: -2,
    col: 1,
    rowSpan: 1,
    colSpan: 1,
    interfaces: [],
    elementInterfaces: [],
  })
  // A real element pointing at the dup harness id.
  project.architecture!.elements.push({
    id: 'ARCH-001',
    kind: 'functional',
    name: 'UI',
    responsibility: 'x',
    row: 0,
    col: 0,
    rowSpan: 1,
    colSpan: 1,
    interfaces: ['IMP_ARCH-HARNESS'],
    elementInterfaces: [],
  })
  assert.equal(project.architecture!.elements.filter((e) => e.kind === 'harness').length, 2)

  const kept = ensureHarnessElement(project)

  assert.equal(kept.id, 'ARCH-HARNESS')
  assert.equal(project.architecture!.elements.filter((e) => e.kind === 'harness').length, 1)
  assert.deepEqual(
    project.architecture!.elements.find((e) => e.id === 'ARCH-001')?.interfaces,
    ['ARCH-HARNESS'],
    'interface reference repointed to the surviving harness',
  )
})
