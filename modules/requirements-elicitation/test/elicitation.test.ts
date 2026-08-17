import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createRequirementFromForm as createRequirementFromFormReal,
  chatWithAnalyst,
  updateRequirementText,
  analyseRequirements,
  importRequirementsFromText,
  checkConflicts,
  checkGaps,
  deleteRequirement,
  setCollapsedRequirementGroups,
  reassignArchitectureElement,
  addRequirementToElement,
  removeRequirementFromElement,
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

test('createRequirementFromForm assigns sequential REQ-NNN ids', () => {
  const project = emptyProject()
  const r1 = createRequirementFromForm(project, { text: 'First requirement' })
  const r2 = createRequirementFromForm(project, { text: 'Second requirement' })

  assert.equal(r1.id, 'REQ-001')
  assert.equal(r2.id, 'REQ-002')
  assert.equal(project.requirements.length, 2)
  assert.equal(r1.status, 'elicited')
  assert.equal(r1.type, null)
})

test('ids are never reused after a requirement is deleted', () => {
  const project = emptyProject()
  createRequirementFromForm(project, { text: 'First' })
  createRequirementFromForm(project, { text: 'Second' })

  // Simulate deletion of REQ-002 (array splice, not touching the counter).
  project.requirements = project.requirements.filter((r) => r.id !== 'REQ-002')
  assert.equal(project.requirements.length, 1)

  const r3 = createRequirementFromForm(project, { text: 'Third' })
  assert.equal(r3.id, 'REQ-003', 'must not reuse REQ-002 after deletion')
})

test('chatWithAnalyst sends existing requirements as context and returns the reply', async () => {
  const project = emptyProject()
  createRequirementFromForm(project, { text: 'The system shall log in a user' })

  const fake = new FakeLlmClient('Sure, what about logout?')
  const result = await chatWithAnalyst(project, fake, 'I need login')

  assert.equal(result.reply, 'Sure, what about logout?')
  assert.deepEqual(result.proposedRequirements, [])
  assert.equal(fake.receivedMessages.length, 1)
  const sentContext = fake.receivedMessages[0].find((m) => m.content.includes('REQ-001'))
  assert.ok(sentContext, 'existing requirement REQ-001 should be included in the prompt context')
})

test('chatWithAnalyst extracts proposed requirements without saving them', async () => {
  const project = emptyProject()
  const fake = new FakeLlmClient(
    'Good idea. Here are some new requirements:\n' +
      'REQUIREMENT: The system shall allow the user to log out\n' +
      'REQUIREMENT: The system shall expire sessions after 30 minutes of inactivity\n' +
      'Let me know if that covers it.',
  )

  const result = await chatWithAnalyst(project, fake, 'What about logout?')

  assert.deepEqual(result.proposedRequirements, [
    'The system shall allow the user to log out',
    'The system shall expire sessions after 30 minutes of inactivity',
  ])
  // Nothing is saved to the project until the caller explicitly accepts a proposal.
  assert.equal(project.requirements.length, 0)
})

test('chatWithAnalyst passes through generic llmOptions to the LlmClient unchanged', async () => {
  const project = emptyProject()
  const fake = new FakeLlmClient('ok')

  await chatWithAnalyst(project, fake, 'hello', { model: 'glm-4.5-air', thinking: 'disabled' })

  assert.equal(fake.receivedOptions.length, 1)
  assert.deepEqual(fake.receivedOptions[0], { model: 'glm-4.5-air', thinking: 'disabled' })
})

test('chatWithAnalyst works with no llmOptions (backward compatible)', async () => {
  const project = emptyProject()
  const fake = new FakeLlmClient('ok')

  await chatWithAnalyst(project, fake, 'hello')

  assert.equal(fake.receivedOptions[0], undefined)
})

test('accepting a proposal is a separate explicit call into createRequirementFromForm', async () => {
  const project = emptyProject()
  const fake = new FakeLlmClient('REQUIREMENT: The system shall allow password reset')
  const result = await chatWithAnalyst(project, fake, 'Add password reset')

  assert.equal(result.proposedRequirements.length, 1)
  const accepted = createRequirementFromForm(project, { text: result.proposedRequirements[0] })

  assert.equal(accepted.id, 'REQ-001')
  assert.equal(project.requirements.length, 1)
  assert.equal(project.requirements[0].text, 'The system shall allow password reset')
})

test('updateRequirementText edits the requirement text in place', () => {
  const project = emptyProject()
  createRequirementFromForm(project, { text: 'Original text' })

  const updated = updateRequirementText(project, 'REQ-001', 'Revised text')

  assert.equal(updated.text, 'Revised text')
  assert.equal(project.requirements[0].text, 'Revised text')
  assert.equal(project.requirements.length, 1, 'edit must not create a new requirement')
})

test('updateRequirementText throws for an unknown requirement id', () => {
  const project = emptyProject()
  assert.throws(() => updateRequirementText(project, 'REQ-999', 'x'), /REQ-999/)
})

test('updateRequirementText recomputes the quality score for the new text', () => {
  const project = emptyProject()
  createRequirementFromForm(project, { text: 'The system provides login.' })

  const updated = updateRequirementText(
    project,
    'REQ-001',
    'When a user submits valid credentials, the system shall grant access.',
  )

  assert.ok(updated.qualityScore)
  assert.equal(updated.qualityScore?.score, 5)
})

test('updateRequirementText regresses a coded/tested/complete requirement to allocated', () => {
  for (const status of ['coded', 'tested', 'complete'] as const) {
    const project = emptyProject()
    createRequirementFromForm(project, { text: 'Original text' })
    project.requirements[0].status = status

    const updated = updateRequirementText(project, 'REQ-001', 'Revised text')

    assert.equal(updated.status, 'allocated', `expected regression from ${status}`)
  }
})

test('updateRequirementText leaves elicited/architected/allocated status untouched', () => {
  for (const status of ['elicited', 'architected', 'allocated'] as const) {
    const project = emptyProject()
    createRequirementFromForm(project, { text: 'Original text' })
    project.requirements[0].status = status

    const updated = updateRequirementText(project, 'REQ-001', 'Revised text')

    assert.equal(updated.status, status)
  }
})

test('analyseRequirements makes one batched call and attaches a per-requirement analystNote', async () => {
  const project = emptyProject()
  createRequirementFromForm(project, { text: 'The system shall allow login' })
  createRequirementFromForm(project, { text: 'The system shall allow logout' })

  const fake = new FakeLlmClient(
    'REQ-001:\nLooks clear and atomic for login.\nSEVERITY: good\n' +
      'REQ-002:\nLooks clear and atomic for logout.\nSEVERITY: good',
  )
  const { results } = await analyseRequirements(project, fake, ['REQ-001', 'REQ-002'])

  assert.equal(results.length, 2)
  assert.deepEqual(
    results.map((r) => r.requirementId),
    ['REQ-001', 'REQ-002'],
  )
  assert.equal(project.requirements[0].analystNote, 'Looks clear and atomic for login.')
  assert.equal(project.requirements[1].analystNote, 'Looks clear and atomic for logout.')
  assert.equal(fake.receivedMessages.length, 1, 'must make a single batched call, not one per requirement')
})

test('analyseRequirements skips unknown ids without throwing', async () => {
  const project = emptyProject()
  createRequirementFromForm(project, { text: 'The system shall allow login' })
  const fake = new FakeLlmClient('REQ-001:\nLooks fine.\nSEVERITY: good')

  const { results } = await analyseRequirements(project, fake, ['REQ-001', 'REQ-999'])

  assert.equal(results.length, 1)
  assert.equal(results[0].requirementId, 'REQ-001')
})

test('analyseRequirements passes through llmOptions to the batched call', async () => {
  const project = emptyProject()
  createRequirementFromForm(project, { text: 'The system shall allow login' })
  const fake = new FakeLlmClient('REQ-001:\nLooks fine.\nSEVERITY: good')

  await analyseRequirements(project, fake, ['REQ-001'], { model: 'glm-4.7' })

  assert.deepEqual(fake.receivedOptions[0], { model: 'glm-4.7' })
})

test('analyseRequirements applies the LLM\'s own SEVERITY verdict on top of text deductions', async () => {
  const project = emptyProject()
  createRequirementFromForm(project, {
    text: 'When a user submits valid credentials, the system shall grant access.',
  })
  const fake = new FakeLlmClient('REQ-001:\nThis requirement is clear and well-formed.\nSEVERITY: good')

  const { results } = await analyseRequirements(project, fake, ['REQ-001'])

  assert.equal(results[0].qualityScore.score, 5)
  assert.equal(project.requirements[0].qualityScore?.score, 5)
  assert.equal(project.requirements[0].qualityScore?.analystSeverity, 'good')
  assert.equal(project.requirements[0].qualityScore?.analystPenalty, 0)
})

test('analyseRequirements strips the SEVERITY line out of the stored/returned analystNote', async () => {
  const project = emptyProject()
  createRequirementFromForm(project, { text: 'The system shall allow login' })
  const fake = new FakeLlmClient('REQ-001:\nLooks clear and atomic.\nSEVERITY: good')

  const { results } = await analyseRequirements(project, fake, ['REQ-001'])

  assert.equal(project.requirements[0].analystNote, 'Looks clear and atomic.')
  assert.equal(results[0].note, 'Looks clear and atomic.')
})

test('a "poor" analyst severity verdict pulls the score down even when regex rules miss the problem', async () => {
  // Regression test for REQ-009: "A worm might change direction, depending
  // upon the speed of reaction" — trips only the "Not a shall statement"
  // regex rule (score 4, green) despite being genuinely untestable. The
  // LLM's own severity verdict is what should catch what the regex can't.
  const project = emptyProject()
  createRequirementFromForm(project, {
    text: 'A worm might change direction, depending upon the speed of reaction',
  })
  const fake = new FakeLlmClient(
    'REQ-001:\nThis requirement is highly ambiguous and fails EARS compliance.\nSEVERITY: poor',
  )

  const { results } = await analyseRequirements(project, fake, ['REQ-001'])

  assert.equal(results[0].qualityScore.analystSeverity, 'poor')
  assert.equal(results[0].qualityScore.analystPenalty, 2)
  assert.ok(results[0].qualityScore.score < 4, 'must no longer score as green (>= 4)')
})

test('a malformed/missing SEVERITY line defaults to "fair", not "good"', async () => {
  const project = emptyProject()
  createRequirementFromForm(project, { text: 'The system shall allow login' })
  const fake = new FakeLlmClient('REQ-001:\nLooks fine, no SEVERITY line here.')

  const { results } = await analyseRequirements(project, fake, ['REQ-001'])

  assert.equal(results[0].qualityScore.analystSeverity, 'fair')
  assert.equal(results[0].qualityScore.analystPenalty, 1)
  assert.equal(project.requirements[0].analystNote, 'Looks fine, no SEVERITY line here.')
})

test('checkConflicts parses CONFLICT lines and sets symmetric conflicts (with rationale) on both requirements', async () => {
  const project = emptyProject()
  createRequirementFromForm(project, { text: 'The system shall lock the account after 3 attempts.' })
  createRequirementFromForm(project, { text: 'The system shall lock the account after 5 attempts.' })
  const fake = new FakeLlmClient(
    'CONFLICT: REQ-001, REQ-002: contradictory lockout thresholds',
  )

  const { pairs } = await checkConflicts(project, fake)

  assert.equal(pairs.length, 1)
  assert.deepEqual(pairs[0].requirementIds, ['REQ-001', 'REQ-002'])
  assert.match(pairs[0].rationale, /contradictory/)
  assert.deepEqual(project.requirements[0].conflicts, [
    { requirementId: 'REQ-002', rationale: 'contradictory lockout thresholds' },
  ])
  assert.deepEqual(project.requirements[1].conflicts, [
    { requirementId: 'REQ-001', rationale: 'contradictory lockout thresholds' },
  ])
  assert.ok(project.requirements[0].conflictsCheckedAt, 'conflictsCheckedAt must be stamped')
  assert.ok(project.requirements[1].conflictsCheckedAt, 'conflictsCheckedAt must be stamped')
})

test('checkConflicts stamps conflictsCheckedAt even on a requirement found clean', async () => {
  const project = emptyProject()
  createRequirementFromForm(project, { text: 'The system shall allow login.' })
  createRequirementFromForm(project, { text: 'The system shall allow logout.' })

  await checkConflicts(project, new FakeLlmClient('NONE'))

  assert.ok(project.requirements[0].conflictsCheckedAt, 'clean requirement must still be stamped as checked')
  assert.deepEqual(project.requirements[0].conflicts, [])
})

test('checkConflicts records the run on project.lastConflictCheck', async () => {
  const project = emptyProject()
  createRequirementFromForm(project, { text: 'The system shall lock the account after 3 attempts.' })
  createRequirementFromForm(project, { text: 'The system shall lock the account after 5 attempts.' })
  const fake = new FakeLlmClient('CONFLICT: REQ-001, REQ-002: contradictory lockout thresholds')

  await checkConflicts(project, fake)

  assert.ok(project.lastConflictCheck)
  assert.equal(project.lastConflictCheck?.pairs.length, 1)
  assert.deepEqual(project.lastConflictCheck?.pairs[0].requirementIds, ['REQ-001', 'REQ-002'])
  assert.ok(project.lastConflictCheck?.checkedAt)
})

test('checkConflicts recomputes quality scores with the conflict penalty applied', async () => {
  const project = emptyProject()
  createRequirementFromForm(project, {
    text: 'When a user submits valid credentials, the system shall grant access.',
  })
  createRequirementFromForm(project, {
    text: 'When a user submits invalid credentials, the system shall deny access.',
  })
  const fake = new FakeLlmClient('CONFLICT: REQ-001, REQ-002: overlapping access rules')

  await checkConflicts(project, fake)

  assert.equal(project.requirements[0].qualityScore?.score, 4)
  assert.equal(project.requirements[0].qualityScore?.conflictPenalty, 1)
  assert.equal(project.requirements[1].qualityScore?.score, 4)
})

test('checkConflicts clears prior conflicts for a requirement no longer flagged', async () => {
  const project = emptyProject()
  createRequirementFromForm(project, { text: 'The system shall lock the account after 3 attempts.' })
  createRequirementFromForm(project, { text: 'The system shall lock the account after 5 attempts.' })

  await checkConflicts(project, new FakeLlmClient('CONFLICT: REQ-001, REQ-002: contradictory'))
  assert.deepEqual(project.requirements[0].conflicts, [
    { requirementId: 'REQ-002', rationale: 'contradictory' },
  ])

  await checkConflicts(project, new FakeLlmClient('NONE'))
  assert.deepEqual(project.requirements[0].conflicts, [])
  assert.equal(project.requirements[0].qualityScore?.conflictPenalty, 0)
})

test('checkConflicts returns an empty array when the reply is NONE', async () => {
  const project = emptyProject()
  createRequirementFromForm(project, { text: 'The system shall allow login.' })
  const fake = new FakeLlmClient('NONE')

  const { pairs } = await checkConflicts(project, fake)

  assert.deepEqual(pairs, [])
})

test('checkConflicts ignores malformed lines and unknown requirement ids without throwing', async () => {
  const project = emptyProject()
  createRequirementFromForm(project, { text: 'The system shall allow login.' })
  const fake = new FakeLlmClient(
    'This is not a valid conflict line\nCONFLICT: REQ-001, REQ-999: unknown id',
  )

  const { pairs } = await checkConflicts(project, fake)

  assert.deepEqual(pairs, [])
})

test('checkConflicts on an empty requirement set makes no LLM call', async () => {
  const project = emptyProject()
  const fake = new FakeLlmClient('NONE')

  const { pairs } = await checkConflicts(project, fake)

  assert.deepEqual(pairs, [])
  assert.equal(fake.receivedMessages.length, 0)
})

test('checkGaps parses GAP lines into suggestion strings without saving anything', async () => {
  const project = emptyProject()
  createRequirementFromForm(project, { text: 'The system shall allow a user to log in.' })
  const fake = new FakeLlmClient(
    'GAP: The system shall allow a user to log out: login exists but no logout is defined',
  )

  const { suggestions } = await checkGaps(project, fake)

  assert.deepEqual(suggestions, ['The system shall allow a user to log out'])
  assert.equal(project.requirements.length, 1, 'checkGaps must not create requirements')
})

test('checkGaps returns an empty array when the reply is NONE', async () => {
  const project = emptyProject()
  createRequirementFromForm(project, { text: 'The system shall allow login.' })
  const fake = new FakeLlmClient('NONE')

  const { suggestions } = await checkGaps(project, fake)

  assert.deepEqual(suggestions, [])
})

test('checkGaps supports multiple GAP lines in one reply', async () => {
  const project = emptyProject()
  createRequirementFromForm(project, { text: 'The system shall allow login.' })
  const fake = new FakeLlmClient(
    'GAP: The system shall allow logout: missing counterpart\n' +
      'GAP: The system shall expire sessions after inactivity: no session timeout defined',
  )

  const { suggestions } = await checkGaps(project, fake)

  assert.deepEqual(suggestions, [
    'The system shall allow logout',
    'The system shall expire sessions after inactivity',
  ])
})

test('checkGaps on an empty requirement set makes no LLM call', async () => {
  const project = emptyProject()
  const fake = new FakeLlmClient('NONE')

  const { suggestions } = await checkGaps(project, fake)

  assert.deepEqual(suggestions, [])
  assert.equal(fake.receivedMessages.length, 0)
})

test('an accepted gap suggestion becomes a real requirement via createRequirementFromForm', async () => {
  const project = emptyProject()
  createRequirementFromForm(project, { text: 'The system shall allow login.' })
  const fake = new FakeLlmClient('GAP: The system shall allow logout: missing counterpart')

  const { suggestions: [suggestion] } = await checkGaps(project, fake)
  const accepted = createRequirementFromForm(project, { text: suggestion })

  assert.equal(accepted.id, 'REQ-002')
  assert.equal(project.requirements.length, 2)
})

test('importRequirementsFromText parses tag+number/##END_OF_REQ blocks into separate requirements', () => {
  const project = emptyProject()

  const created = importRequirementsFromText(
    project,
    'REQ_001\nThe system shall allow login.\n##END_OF_REQ\n' +
      'REQ_002\nThe system shall allow logout.\n##END_OF_REQ\n' +
      'REQ_003\nThe system shall log audit events.\n##END_OF_REQ',
    1,
  )

  assert.equal(created.length, 3)
  assert.deepEqual(
    created.map((r) => r.id),
    ['REQ-001', 'REQ-002', 'REQ-003'],
  )
  assert.equal(created[0].text, 'The system shall allow login.')
  assert.equal(created[1].text, 'The system shall allow logout.')
  assert.equal(created[2].text, 'The system shall log audit events.')
})

test('importRequirementsFromText accepts a variable tag prefix and multi-line bodies', () => {
  const project = emptyProject()

  const created = importRequirementsFromText(
    project,
    'BUG-014\nWhen the user submits invalid credentials,\nthe system shall deny access.\n##END_OF_REQ',
    1,
  )

  assert.equal(created.length, 1)
  assert.equal(created[0].text, 'When the user submits invalid credentials,\nthe system shall deny access.')
})

test('importRequirementsFromText trims whitespace around each requirement body', () => {
  const project = emptyProject()

  const created = importRequirementsFromText(
    project,
    'REQ_001\n  The system shall allow login.  \n##END_OF_REQ',
    1,
  )

  assert.equal(created[0].text, 'The system shall allow login.')
})

test('importRequirementsFromText rejects text with no tag/##END_OF_REQ markers', () => {
  const project = emptyProject()

  assert.throws(
    () => importRequirementsFromText(project, 'The system shall allow login.\n\nThe system shall allow logout.', 1),
    /expected format/,
  )
  assert.equal(project.requirements.length, 0, 'nothing should be imported on a format rejection')
})

test('importRequirementsFromText rejects a block missing its ##END_OF_REQ terminator', () => {
  const project = emptyProject()

  assert.throws(
    () => importRequirementsFromText(project, 'REQ_001\nThe system shall allow login.', 1),
    /expected format/,
  )
})

test('importRequirementsFromText ignores empty/whitespace-only input', () => {
  const project = emptyProject()

  const created = importRequirementsFromText(project, '\n\n   \n\n', 1)

  assert.equal(created.length, 0)
  assert.equal(project.requirements.length, 0)
})

test('checkConflicts excludes deleted requirements from the prompt and result set', async () => {
  const project = emptyProject()
  createRequirementFromForm(project, { text: 'The system shall lock the account after 3 attempts.' })
  createRequirementFromForm(project, { text: 'The system shall lock the account after 5 attempts.' })
  deleteRequirement(project, 'REQ-002')

  const fake = new FakeLlmClient('NONE')
  const { pairs } = await checkConflicts(project, fake)

  assert.deepEqual(pairs, [])
  const sentMessages = fake.receivedMessages[0]
  const promptText = sentMessages.map((m) => m.content).join('\n')
  assert.ok(!promptText.includes('REQ-002'), 'deleted requirement must not be sent to the LLM')
})

test('checkConflicts on a set of only-deleted requirements makes no LLM call', async () => {
  const project = emptyProject()
  createRequirementFromForm(project, { text: 'The system shall allow login.' })
  deleteRequirement(project, 'REQ-001')

  const fake = new FakeLlmClient('NONE')
  const { pairs } = await checkConflicts(project, fake)

  assert.deepEqual(pairs, [])
  assert.equal(fake.receivedMessages.length, 0)
})

test('checkGaps excludes deleted requirements from the prompt', async () => {
  const project = emptyProject()
  createRequirementFromForm(project, { text: 'The system shall allow login.' })
  createRequirementFromForm(project, { text: 'The system shall allow logout.' })
  deleteRequirement(project, 'REQ-002')

  const fake = new FakeLlmClient('NONE')
  await checkGaps(project, fake)

  const sentMessages = fake.receivedMessages[0]
  const promptText = sentMessages.map((m) => m.content).join('\n')
  assert.ok(!promptText.includes('REQ-002'), 'deleted requirement must not be sent to the LLM')
})

test('chatWithAnalyst excludes deleted requirements from chat context', async () => {
  const project = emptyProject()
  createRequirementFromForm(project, { text: 'The system shall log in a user' })
  createRequirementFromForm(project, { text: 'The system shall log out a user' })
  deleteRequirement(project, 'REQ-002')

  const fake = new FakeLlmClient('ok')
  await chatWithAnalyst(project, fake, 'hello')

  const sentMessages = fake.receivedMessages[0]
  const promptText = sentMessages.map((m) => m.content).join('\n')
  assert.ok(promptText.includes('REQ-001'), 'active requirement should still be included')
  assert.ok(!promptText.includes('REQ-002'), 'deleted requirement must not be sent to the LLM')
})

test('analyseRequirements refuses to analyse a deleted requirement id', async () => {
  const project = emptyProject()
  createRequirementFromForm(project, { text: 'The system shall allow login.' })
  deleteRequirement(project, 'REQ-001')

  const fake = new FakeLlmClient('ok')
  const { results } = await analyseRequirements(project, fake, ['REQ-001'])

  assert.equal(results.length, 0)
  assert.equal(fake.receivedMessages.length, 0)
})

test('updateRequirementText refuses to edit a deleted requirement', () => {
  const project = emptyProject()
  createRequirementFromForm(project, { text: 'Original text' })
  deleteRequirement(project, 'REQ-001')

  assert.throws(() => updateRequirementText(project, 'REQ-001', 'New text'), /REQ-001/)
})

test('setCollapsedRequirementGroups replaces the persisted collapsed-group set', () => {
  const project = emptyProject()

  setCollapsedRequirementGroups(project, ['element-a', 'Unallocated to Architecture'])
  assert.deepEqual(project.collapsedRequirementGroups, ['element-a', 'Unallocated to Architecture'])

  setCollapsedRequirementGroups(project, ['element-b'])
  assert.deepEqual(project.collapsedRequirementGroups, ['element-b'])

  setCollapsedRequirementGroups(project, [])
  assert.deepEqual(project.collapsedRequirementGroups, [])
})

test('reassignArchitectureElement replaces (not appends) the single-element allocation and advances status to allocated', () => {
  const project = emptyProject()
  const requirement = createRequirementFromForm(project, { text: 'The system shall do a thing' })

  reassignArchitectureElement(project, requirement.id, 'ARCH-001')
  assert.deepEqual(requirement.architectureElements, ['ARCH-001'])
  assert.equal(requirement.status, 'allocated')

  reassignArchitectureElement(project, requirement.id, 'ARCH-002')
  assert.deepEqual(requirement.architectureElements, ['ARCH-002'], 'replaces, does not append')

  reassignArchitectureElement(project, requirement.id, null)
  assert.deepEqual(requirement.architectureElements, [])
})

test('reassignArchitectureElement throws for an unknown requirement id', () => {
  const project = emptyProject()
  assert.throws(() => reassignArchitectureElement(project, 'REQ-999', 'ARCH-001'), /REQ-999/)
})

test('addRequirementToElement appends to the allocation array and advances status to allocated', () => {
  const project = emptyProject()
  const requirement = createRequirementFromForm(project, { text: 'The system shall do a thing' })

  addRequirementToElement(project, requirement.id, 'ARCH-001')
  assert.deepEqual(requirement.architectureElements, ['ARCH-001'])
  assert.equal(requirement.status, 'allocated')

  addRequirementToElement(project, requirement.id, 'ARCH-002')
  assert.deepEqual(requirement.architectureElements, ['ARCH-001', 'ARCH-002'], 'adds alongside, does not replace')
})

test('addRequirementToElement dedupes — adding an already-allocated element is a no-op on the array', () => {
  const project = emptyProject()
  const requirement = createRequirementFromForm(project, { text: 'The system shall do a thing' })

  addRequirementToElement(project, requirement.id, 'ARCH-001')
  addRequirementToElement(project, requirement.id, 'ARCH-001')
  assert.deepEqual(requirement.architectureElements, ['ARCH-001'])
})

test('addRequirementToElement throws for an unknown requirement id', () => {
  const project = emptyProject()
  assert.throws(() => addRequirementToElement(project, 'REQ-999', 'ARCH-001'), /REQ-999/)
})

test('removeRequirementFromElement removes only the given element, leaving other allocations untouched', () => {
  const project = emptyProject()
  const requirement = createRequirementFromForm(project, { text: 'The system shall do a thing' })
  addRequirementToElement(project, requirement.id, 'ARCH-001')
  addRequirementToElement(project, requirement.id, 'ARCH-002')

  removeRequirementFromElement(project, requirement.id, 'ARCH-001')
  assert.deepEqual(requirement.architectureElements, ['ARCH-002'])
})

test('removeRequirementFromElement never regresses status', () => {
  const project = emptyProject()
  const requirement = createRequirementFromForm(project, { text: 'The system shall do a thing' })
  addRequirementToElement(project, requirement.id, 'ARCH-001')
  addRequirementToElement(project, requirement.id, 'ARCH-002')
  requirement.status = 'complete'

  removeRequirementFromElement(project, requirement.id, 'ARCH-001')
  assert.equal(requirement.status, 'complete')
  assert.deepEqual(requirement.architectureElements, ['ARCH-002'])
})

test('removeRequirementFromElement throws for an unknown requirement id', () => {
  const project = emptyProject()
  assert.throws(() => removeRequirementFromElement(project, 'REQ-999', 'ARCH-001'), /REQ-999/)
})
