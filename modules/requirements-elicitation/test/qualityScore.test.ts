import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeQualityScore, parseAnalystSeverity, parseAnalysisBlocks } from '../src/index.js'

test('a clean EARS-style requirement scores 5 with no deductions', () => {
  const result = computeQualityScore(
    'When a user submits valid credentials, the system shall grant access to the dashboard.',
  )
  assert.equal(result.score, 5)
  assert.deepEqual(result.deductions, [])
  assert.equal(result.conflictPenalty, 0)
})

test('vague terms deduct 1 point (INCOSE R7)', () => {
  const result = computeQualityScore('The system shall provide a reasonable response time.')
  const rule = result.deductions.find((d) => d.rule === 'Vague terms')
  assert.ok(rule)
  assert.equal(rule?.amount, 1)
  assert.equal(result.score, 4)
})

test('escape clauses deduct 1 point (INCOSE R8)', () => {
  const result = computeQualityScore('The system shall log errors where possible.')
  const rule = result.deductions.find((d) => d.rule === 'Escape clauses')
  assert.ok(rule)
  assert.equal(result.score, 4)
})

test('open-ended clauses deduct 1 point (INCOSE R9)', () => {
  const result = computeQualityScore('The system shall support login, logout, etc.')
  const rule = result.deductions.find((d) => d.rule === 'Open-ended clauses')
  assert.ok(rule)
  assert.equal(result.score, 4)
})

test('superfluous infinitives deduct 0.5 (INCOSE R10)', () => {
  const result = computeQualityScore('The system shall be able to export reports.')
  const rule = result.deductions.find((d) => d.rule === 'Superfluous infinitives')
  assert.ok(rule)
  assert.equal(rule?.amount, 0.5)
  assert.equal(result.score, 4.5)
})

test('ambiguous pronoun deducts 0.5 (INCOSE R24)', () => {
  const result = computeQualityScore('The system shall validate the input, then process it.')
  const rule = result.deductions.find((d) => d.rule === 'Ambiguous pronoun')
  assert.ok(rule)
  assert.equal(rule?.amount, 0.5)
  assert.equal(result.score, 4.5)
})

test('unachievable absolutes deduct 0.5 (INCOSE R26)', () => {
  const result = computeQualityScore('The system shall always respond within the timeout.')
  const rule = result.deductions.find((d) => d.rule === 'Unachievable absolutes')
  assert.ok(rule)
  assert.equal(result.score, 4.5)
})

test('oblique symbol deducts 0.5 (INCOSE R17)', () => {
  const result = computeQualityScore('The system shall restrict access by user/admin role.')
  const rule = result.deductions.find((d) => d.rule === 'Oblique symbol')
  assert.ok(rule)
})

test('missing "shall" deducts 1 point (EARS baseline)', () => {
  const result = computeQualityScore('The system provides a login page.')
  const rule = result.deductions.find((d) => d.rule === 'Not a "shall" statement')
  assert.ok(rule)
  assert.equal(result.score, 4)
})

test('speculative language ("might") deducts 1 point (EARS baseline)', () => {
  const result = computeQualityScore('The system might grant access.')
  const rule = result.deductions.find((d) => d.rule === 'Speculative/non-mandatory language')
  assert.ok(rule)
  assert.equal(rule?.amount, 1)
})

test('"shall" does not false-positive against the speculative-language rule', () => {
  const result = computeQualityScore(
    'When a user submits valid credentials, the system shall grant access to the dashboard.',
  )
  const rule = result.deductions.find((d) => d.rule === 'Speculative/non-mandatory language')
  assert.equal(rule, undefined)
})

test('REQ-009 ("A worm might change direction...") scores 3, not 4 — no longer green', () => {
  const result = computeQualityScore(
    'A worm might change direction, depending upon the speed of reaction',
  )
  assert.equal(result.score, 3)
  const ruleNames = result.deductions.map((d) => d.rule)
  assert.ok(ruleNames.includes('Not a "shall" statement'))
  assert.ok(ruleNames.includes('Speculative/non-mandatory language'))
})

test('compound/multiple thoughts deducts 1 point (INCOSE R18/R19)', () => {
  const result = computeQualityScore(
    'The system shall validate the email and check the password and log the attempt.',
  )
  const rule = result.deductions.find((d) => d.rule === 'Compound/multiple thoughts')
  assert.ok(rule)
  assert.equal(result.score, 4)
})

test('a single "and" does not trigger the compound-thoughts rule', () => {
  const result = computeQualityScore('The system shall validate the username and password.')
  const rule = result.deductions.find((d) => d.rule === 'Compound/multiple thoughts')
  assert.equal(rule, undefined)
})

test('stacking multiple violations floors the score at 1, never below', () => {
  const result = computeQualityScore(
    'The system should provide a reasonable and/or fast response where possible, ' +
      'and it shall always handle all requests and log them, etc.',
  )
  assert.ok(result.deductions.length >= 4)
  assert.equal(result.score, 1)
})

test('conflictCount applies a further -1 per conflict on top of text deductions', () => {
  const clean = computeQualityScore(
    'When a user submits valid credentials, the system shall grant access.',
  )
  assert.equal(clean.score, 5)

  const withOneConflict = computeQualityScore(
    'When a user submits valid credentials, the system shall grant access.',
    1,
  )
  assert.equal(withOneConflict.score, 4)
  assert.equal(withOneConflict.conflictPenalty, 1)

  const withTwoConflicts = computeQualityScore(
    'When a user submits valid credentials, the system shall grant access.',
    2,
  )
  assert.equal(withTwoConflicts.score, 3)
  assert.equal(withTwoConflicts.conflictPenalty, 2)
})

test('conflict penalty also floors at 1 in combination with text deductions', () => {
  const result = computeQualityScore('The system should be able to handle it, etc.', 5)
  assert.equal(result.score, 1)
})

test('score is always rounded to the nearest 0.5 step', () => {
  const result = computeQualityScore('The system shall be able to export data.')
  const remainder = (result.score * 2) % 1
  assert.equal(remainder, 0, `expected score ${result.score} to be a multiple of 0.5`)
})

test('analystSeverity "good" applies no extra penalty', () => {
  const result = computeQualityScore(
    'When a user submits valid credentials, the system shall grant access.',
    0,
    'good',
  )
  assert.equal(result.score, 5)
  assert.equal(result.analystSeverity, 'good')
  assert.equal(result.analystPenalty, 0)
})

test('analystSeverity "fair" deducts 1, "poor" deducts 2, on top of text/conflict deductions', () => {
  const fair = computeQualityScore('The system shall allow login.', 0, 'fair')
  assert.equal(fair.score, 4)
  assert.equal(fair.analystPenalty, 1)

  const poor = computeQualityScore('The system shall allow login.', 0, 'poor')
  assert.equal(poor.score, 3)
  assert.equal(poor.analystPenalty, 2)
})

test('omitting analystSeverity leaves it and analystPenalty undefined (Review Clarity / edit path)', () => {
  const result = computeQualityScore('The system shall allow login.')
  assert.equal(result.analystSeverity, undefined)
  assert.equal(result.analystPenalty, undefined)
})

test('parseAnalystSeverity strips a trailing SEVERITY line and returns the parsed severity', () => {
  const { note, severity } = parseAnalystSeverity(
    'This requirement is clear and testable.\nSEVERITY: good',
  )
  assert.equal(note, 'This requirement is clear and testable.')
  assert.equal(severity, 'good')
})

test('parseAnalystSeverity is case-insensitive on the severity word', () => {
  const { severity } = parseAnalystSeverity('Some notes.\nSEVERITY: Poor')
  assert.equal(severity, 'poor')
})

test('parseAnalystSeverity defaults to "fair" and returns the full trimmed text when the line is missing', () => {
  const { note, severity } = parseAnalystSeverity('This requirement has no severity marker.')
  assert.equal(note, 'This requirement has no severity marker.')
  assert.equal(severity, 'fair')
})

test('parseAnalysisBlocks splits a batched reply into one entry per REQ-NNN block', () => {
  const reply =
    'REQ-001:\nClear and atomic.\nSEVERITY: good\n' +
    'REQ-002:\nUses "might" instead of "shall".\nSEVERITY: poor'

  const blocks = parseAnalysisBlocks(reply)

  assert.equal(blocks.length, 2)
  assert.deepEqual(blocks[0], { requirementId: 'REQ-001', note: 'Clear and atomic.', severity: 'good' })
  assert.deepEqual(blocks[1], {
    requirementId: 'REQ-002',
    note: 'Uses "might" instead of "shall".',
    severity: 'poor',
  })
})

test('parseAnalysisBlocks preserves given order and handles a single block', () => {
  const blocks = parseAnalysisBlocks('REQ-003:\nLooks fine.\nSEVERITY: good')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].requirementId, 'REQ-003')
})

test('parseAnalysisBlocks returns an empty array when no REQ-NNN headers are present', () => {
  assert.deepEqual(parseAnalysisBlocks('Some unstructured reply with no headers.'), [])
})

test('parseAnalysisBlocks defaults a block missing its SEVERITY line to "fair"', () => {
  const blocks = parseAnalysisBlocks('REQ-001:\nNo severity line here.')
  assert.equal(blocks[0].severity, 'fair')
})
