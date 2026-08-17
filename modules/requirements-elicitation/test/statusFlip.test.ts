import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createRequirementFromForm as createRequirementFromFormReal,
  reassignArchitectureElement,
  setRequirementStatus,
  advanceStatusForward,
} from '../src/index.js'
import type { CreateRequirementFields, Project, Requirement } from '../src/index.js'

function emptyProject(): Project {
  return { schemaVersion: 1, id: 'proj-1', name: 'Test', projectMode: 'new', requirements: [] }
}

const seqByProject = new WeakMap<Project, number>()
function createRequirementFromForm(project: Project, fields: CreateRequirementFields): Requirement {
  const seq = seqByProject.get(project) ?? 1
  seqByProject.set(project, seq + 1)
  return createRequirementFromFormReal(project, fields, seq)
}

test('reassignArchitectureElement advances an elicited requirement to allocated', () => {
  const project = emptyProject()
  const requirement = createRequirementFromForm(project, { text: 'The system shall do X' })

  reassignArchitectureElement(project, requirement.id, 'ARCH-001')

  assert.equal(requirement.status, 'allocated')
})

test('reassignArchitectureElement does not regress a requirement already further along than allocated', () => {
  const project = emptyProject()
  const requirement = createRequirementFromForm(project, { text: 'The system shall do X' })
  setRequirementStatus(project, requirement.id, 'complete')

  reassignArchitectureElement(project, requirement.id, 'ARCH-001')

  assert.equal(requirement.status, 'complete', 'allocation must never pull a further-along requirement backward')
})

test('reassignArchitectureElement to null (unallocate) does not touch status', () => {
  const project = emptyProject()
  const requirement = createRequirementFromForm(project, { text: 'The system shall do X' })
  setRequirementStatus(project, requirement.id, 'allocated')

  reassignArchitectureElement(project, requirement.id, null)

  assert.equal(requirement.status, 'allocated')
})

test('advanceStatusForward never regresses a status', () => {
  const project = emptyProject()
  const requirement = createRequirementFromForm(project, { text: 'x' })
  setRequirementStatus(project, requirement.id, 'tested')

  advanceStatusForward(requirement, 'coded')

  assert.equal(requirement.status, 'tested')
})

test('advanceStatusForward advances a status', () => {
  const project = emptyProject()
  const requirement = createRequirementFromForm(project, { text: 'x' })
  setRequirementStatus(project, requirement.id, 'allocated')

  advanceStatusForward(requirement, 'coded')

  assert.equal(requirement.status, 'coded')
})
