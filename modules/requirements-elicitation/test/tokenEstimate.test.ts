import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  estimateTokensForText,
  contextLimitForModel,
  estimateAnalysisTokens,
  estimateCodeGapScanTokens,
  DEFAULT_CODE_STRIP_OPTIONS,
  ANALYSIS_SYSTEM_PROMPT,
  CODE_GAP_SCAN_SYSTEM_PROMPT,
  createRequirementFromForm as createRequirementFromFormReal,
} from '../src/index.js'
import type { CodeStripOptions, Project, CreateRequirementFields, Requirement } from '../src/index.js'

const NO_STRIP: CodeStripOptions = { stripBlankLines: false, stripComments: false, stripBodies: false }

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

test('estimateTokensForText approximates 4 chars per token, rounding up', () => {
  assert.equal(estimateTokensForText(''), 0)
  assert.equal(estimateTokensForText('abcd'), 1)
  assert.equal(estimateTokensForText('abcde'), 2)
})

test('contextLimitForModel returns GLM-5.2\'s large window with warnAt scaled to 80% of it, not a flat figure', () => {
  const limit = contextLimitForModel('glm-5.2')
  assert.equal(limit.contextWindow, 1_000_000)
  assert.equal(limit.warnAt, 800_000)
})

test('contextLimitForModel returns GLM-4.7\'s 200k window, not the smaller 128k figure used by older GLM-4.x models', () => {
  const limit = contextLimitForModel('glm-4.7')
  assert.equal(limit.contextWindow, 200_000)
  assert.equal(limit.warnAt, 160_000)
})

test('contextLimitForModel falls back to a conservative default for an unknown/unset model', () => {
  assert.deepEqual(contextLimitForModel(undefined), { contextWindow: 128_000, warnAt: 102_400 })
  assert.deepEqual(contextLimitForModel('some-future-model'), { contextWindow: 128_000, warnAt: 102_400 })
})

test('estimateAnalysisTokens only counts requirements in requirementIds, not the whole project', () => {
  const project = emptyProject()
  createRequirementFromForm(project, { text: 'The system shall allow login.' })
  createRequirementFromForm(project, { text: 'The system shall allow logout.' })

  const estimate = estimateAnalysisTokens(
    project.requirements,
    ['REQ-001'],
    ANALYSIS_SYSTEM_PROMPT,
    'glm-5.2',
  )

  assert.equal(estimate.inputTokens, estimateTokensForText(ANALYSIS_SYSTEM_PROMPT) + estimateTokensForText('REQ-001: The system shall allow login.'))
  assert.equal(estimate.estimatedOutputTokens, 60)
  assert.equal(estimate.totalTokens, estimate.inputTokens + estimate.estimatedOutputTokens)
})

test('estimateAnalysisTokens flags nearContextLimit once totalTokens crosses warnAt', () => {
  const project = emptyProject()
  // glm-4.7's warnAt is 160,000 tokens (80% of its 200k window) — repeat
  // enough text to comfortably clear that at ~4 chars/token.
  const bigText = 'The system shall handle this scenario. '.repeat(20000)
  createRequirementFromForm(project, { text: bigText })

  const estimate = estimateAnalysisTokens(
    project.requirements,
    ['REQ-001'],
    ANALYSIS_SYSTEM_PROMPT,
    'glm-4.7',
  )

  assert.ok(estimate.totalTokens >= estimate.warnAt)
  assert.equal(estimate.nearContextLimit, true)
})

test('estimateAnalysisTokens does not flag nearContextLimit for a small requirement set', () => {
  const project = emptyProject()
  createRequirementFromForm(project, { text: 'The system shall allow login.' })

  const estimate = estimateAnalysisTokens(
    project.requirements,
    ['REQ-001'],
    ANALYSIS_SYSTEM_PROMPT,
    'glm-5.2',
  )

  assert.equal(estimate.nearContextLimit, false)
})

test('estimateCodeGapScanTokens echoes back the model it was given, so the UI can show which model the window belongs to', () => {
  const estimate = estimateCodeGapScanTokens(
    [{ path: 'a.ts', content: 'const a = 1' }],
    [],
    CODE_GAP_SCAN_SYSTEM_PROMPT,
    NO_STRIP,
    'glm-5.2',
  )

  assert.equal(estimate.model, 'glm-5.2')
  assert.equal(estimate.contextWindow, 1_000_000)
})

test('estimateCodeGapScanTokens leaves model undefined and uses the generic default when no model is given', () => {
  const estimate = estimateCodeGapScanTokens(
    [{ path: 'a.ts', content: 'const a = 1' }],
    [],
    CODE_GAP_SCAN_SYSTEM_PROMPT,
    NO_STRIP,
  )

  assert.equal(estimate.model, undefined)
  assert.equal(estimate.contextWindow, 128_000)
})

test('estimateCodeGapScanTokens.complete returns one entry per file plus a total including fixed overhead', () => {
  const estimate = estimateCodeGapScanTokens(
    [
      { path: 'a.ts', content: 'const a = 1' },
      { path: 'b.ts', content: 'const b = 2' },
    ],
    [],
    CODE_GAP_SCAN_SYSTEM_PROMPT,
    NO_STRIP,
    'glm-5.2',
  )

  assert.deepEqual(
    estimate.complete.files.map((f) => f.path),
    ['a.ts', 'b.ts'],
  )
  assert.equal(estimate.complete.files[0].tokens, estimateTokensForText('const a = 1'))
  assert.ok(estimate.complete.singleCallTotalTokens > estimate.complete.fixedOverheadTokens)
})

test('estimateCodeGapScanTokens.complete flags singleCallFits false once the total crosses warnAt for the model', () => {
  // glm-4.7's warnAt is 160,000 tokens (80% of its 200k window) — repeat
  // enough to comfortably clear that at ~4 chars/token.
  const bigFile = { path: 'big.ts', content: 'const x = 1; '.repeat(60000) }

  const estimate = estimateCodeGapScanTokens([bigFile], [], CODE_GAP_SCAN_SYSTEM_PROMPT, NO_STRIP, 'glm-4.7')

  assert.ok(estimate.complete.singleCallTotalTokens >= estimate.warnAt)
  assert.equal(estimate.complete.singleCallFits, false)
})

test('estimateCodeGapScanTokens makes perFileTotalTokens pay the fixed overhead once per file, unlike singleCallTotalTokens', () => {
  const estimate = estimateCodeGapScanTokens(
    [
      { path: 'a.ts', content: 'const a = 1' },
      { path: 'b.ts', content: 'const b = 2' },
      { path: 'c.ts', content: 'const c = 3' },
    ],
    [],
    CODE_GAP_SCAN_SYSTEM_PROMPT,
    NO_STRIP,
    'glm-5.2',
  )

  assert.equal(estimate.complete.perFileCallCount, 3)
  assert.ok(estimate.complete.perFileTotalTokens > estimate.complete.singleCallTotalTokens)
  assert.equal(
    estimate.complete.perFileTotalTokens - estimate.complete.singleCallTotalTokens,
    estimate.complete.fixedOverheadTokens * (estimate.complete.perFileCallCount - 1),
  )
})

test('estimateCodeGapScanTokens.complete reports singleCallFits true for a small import', () => {
  const estimate = estimateCodeGapScanTokens(
    [{ path: 'a.ts', content: 'const a = 1' }],
    [],
    CODE_GAP_SCAN_SYSTEM_PROMPT,
    NO_STRIP,
    'glm-5.2',
  )

  assert.equal(estimate.complete.singleCallFits, true)
})

test('estimateCodeGapScanTokens.stripped uses fewer (or equal) tokens than complete when stripping blank lines', () => {
  const estimate = estimateCodeGapScanTokens(
    [{ path: 'a.ts', content: 'const a = 1\n\n\n\nconst b = 2\n\n\n\nconst c = 3' }],
    [],
    CODE_GAP_SCAN_SYSTEM_PROMPT,
    DEFAULT_CODE_STRIP_OPTIONS,
    'glm-5.2',
  )

  assert.ok(estimate.stripped.files[0].tokens <= estimate.complete.files[0].tokens)
})

test('estimateCodeGapScanTokens.stripped equals complete when every strip option is off', () => {
  const estimate = estimateCodeGapScanTokens(
    [{ path: 'a.ts', content: 'const a = 1\n\n\nconst b = 2' }],
    [],
    CODE_GAP_SCAN_SYSTEM_PROMPT,
    NO_STRIP,
    'glm-5.2',
  )

  assert.equal(estimate.stripped.files[0].tokens, estimate.complete.files[0].tokens)
})
