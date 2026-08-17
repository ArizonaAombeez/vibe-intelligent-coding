import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripCodeFileContent, stripCodeFiles, DEFAULT_CODE_STRIP_OPTIONS } from '../src/index.js'
import type { CodeStripOptions } from '../src/index.js'

const NO_STRIP: CodeStripOptions = { stripBlankLines: false, stripComments: false, stripBodies: false }

test('stripCodeFileContent with everything off returns the content unchanged', () => {
  const content = 'const a = 1\n\n// a comment\nfunction f() { return a }'
  assert.equal(stripCodeFileContent(content, NO_STRIP), content)
})

test('stripBlankLines removes blank lines but keeps comments and logic intact', () => {
  const content = 'const a = 1\n\n\n// keep me\nfunction f() {\n  return a\n}\n'
  const result = stripCodeFileContent(content, { stripBlankLines: true, stripComments: false, stripBodies: false })

  assert.doesNotMatch(result, /\n\n/)
  assert.match(result, /\/\/ keep me/)
  assert.match(result, /return a/)
})

test('stripComments removes line and block comments but keeps code', () => {
  const content = 'const a = 1 // trailing\n/* block\n comment */\nfunction f() { return a }'
  const result = stripCodeFileContent(content, { stripBlankLines: false, stripComments: true, stripBodies: false })

  assert.doesNotMatch(result, /trailing/)
  assert.doesNotMatch(result, /block/)
  assert.match(result, /const a = 1/)
  assert.match(result, /function f\(\) { return a }/)
})

test('stripBodies keeps signatures but discards function body content', () => {
  const content = 'function validateEmail(addr) {\n  if (!addr.includes("@")) {\n    throw new Error("bad")\n  }\n  return true\n}'
  const result = stripCodeFileContent(content, { stripBlankLines: false, stripComments: false, stripBodies: true })

  assert.match(result, /function validateEmail\(addr\)/)
  assert.doesNotMatch(result, /bad/)
  assert.doesNotMatch(result, /includes/)
})

test('stripBodies leaves content with no braces (e.g. Python-like) unchanged', () => {
  const content = 'def validate_email(addr):\n    if "@" not in addr:\n        raise ValueError("bad")\n    return True'
  const result = stripCodeFileContent(content, { stripBlankLines: false, stripComments: false, stripBodies: true })

  assert.equal(result, content)
})

test('DEFAULT_CODE_STRIP_OPTIONS strips blank lines only, preserving comments and bodies', () => {
  assert.deepEqual(DEFAULT_CODE_STRIP_OPTIONS, {
    stripBlankLines: true,
    stripComments: false,
    stripBodies: false,
  })
})

test('stripCodeFiles preserves file paths and applies the same options to every file', () => {
  const files = [
    { path: 'a.ts', content: 'const a = 1\n\n\nconst b = 2' },
    { path: 'b.ts', content: 'const c = 3\n\n\nconst d = 4' },
  ]

  const result = stripCodeFiles(files, { stripBlankLines: true, stripComments: false, stripBodies: false })

  assert.deepEqual(result.map((f) => f.path), ['a.ts', 'b.ts'])
  assert.doesNotMatch(result[0].content, /\n\n/)
  assert.doesNotMatch(result[1].content, /\n\n/)
})

test('stripCodeFiles returns the original array reference when every option is off', () => {
  const files = [{ path: 'a.ts', content: 'const a = 1' }]
  assert.equal(stripCodeFiles(files, NO_STRIP), files)
})
