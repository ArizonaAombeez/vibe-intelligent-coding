#!/usr/bin/env node
// Stand-in for the real `claude` CLI in agentic (filesystem-writing) mode,
// driven by env vars so tests don't depend on the real CLI or a real LLM
// call. Mirrors `claude --print --output-format json --permission-mode ...`
// closely enough for ClaudeCodeAgentClient to be tested against, and
// additionally performs a real filesystem write relative to its own cwd
// (mode-dependent) so vic-coding's write-scope gate can be tested against
// an actual out-of-scope write, not just a mocked result shape.

import { writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

const mode = process.env.FAKE_CLAUDE_MODE ?? 'ok'
const args = process.argv.slice(2)

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

const prompt = await readStdin()
void prompt

async function writeUnder(relativePath, content) {
  const full = path.resolve(process.cwd(), relativePath)
  await mkdir(path.dirname(full), { recursive: true })
  await writeFile(full, content, 'utf8')
}

if (mode === 'ok') {
  process.stdout.write(
    JSON.stringify({ type: 'result', is_error: false, result: 'done', session_id: 'agent-session-1' }),
  )
  process.exit(0)
} else if (mode === 'write-in-scope') {
  await writeUnder(process.env.FAKE_CLAUDE_WRITE_PATH ?? 'in-scope-file.txt', 'in scope content')
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'wrote in-scope file' }))
  process.exit(0)
} else if (mode === 'write-out-of-scope') {
  await writeUnder(process.env.FAKE_CLAUDE_WRITE_PATH ?? 'sibling-folder/out-of-scope-file.txt', 'escaped content')
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'wrote out-of-scope file' }))
  process.exit(0)
} else if (mode === 'error-result') {
  process.stdout.write(JSON.stringify({ type: 'result', is_error: true, result: null, subtype: 'error_max_turns' }))
  process.exit(0)
} else if (mode === 'nonzero-exit') {
  process.stderr.write('simulated agent CLI failure')
  process.exit(1)
} else if (mode === 'echo-args') {
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: JSON.stringify(args) }))
  process.exit(0)
} else if (mode === 'write-in-scope-declare-run-command') {
  await writeUnder(process.env.FAKE_CLAUDE_WRITE_PATH ?? 'in-scope-file.txt', 'in scope content')
  const runLine = process.env.FAKE_CLAUDE_RUN_LINE ?? 'RUN: node test.mjs'
  process.stdout.write(
    JSON.stringify({ type: 'result', is_error: false, result: `Wrote the test.\n${runLine}` }),
  )
  process.exit(0)
}
