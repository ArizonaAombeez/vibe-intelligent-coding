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
  const writePath = process.env.FAKE_CLAUDE_WRITE_PATH ?? 'in-scope-file.txt'
  await writeUnder(writePath, 'in scope content')
  // vic-coding now requires every run to leave a runnable "*.test.<ext>"
  // file (SW tests are mandatory) — mirror that here so the common
  // "wrote in-scope code, run succeeds" path stays a success. A test that
  // specifically exercises the missing-tests rejection sets
  // FAKE_CLAUDE_NO_TEST=1 to suppress this.
  if (process.env.FAKE_CLAUDE_NO_TEST !== '1' && !/\.test\.[^./\\]+$/.test(writePath)) {
    const ext = path.extname(writePath) || '.txt'
    const base = writePath.slice(0, writePath.length - ext.length) || 'in-scope-file'
    // Include a `// covers:` tag (T3.3 requirement-coverage check) — the
    // runCoding fixtures allocate REQ-001 to the element under test, and
    // FAKE_CLAUDE_COVERS lets a caller override which id(s) to tag.
    const covers = process.env.FAKE_CLAUDE_COVERS ?? 'REQ-001'
    await writeUnder(`${base}.test.mjs`, `// covers: ${covers}\nprocess.exit(0)\n`)
  }
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'wrote in-scope file', session_id: 'fake-session-1' }))
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
} else if (mode === 'stream-events') {
  // Emits a realistic --output-format stream-json sequence: an assistant
  // frame with a thinking block + a tool_use, a user frame with a failed
  // tool_result, then the terminal result frame. Used to test that
  // ClaudeCodeAgentClient normalises these into OpenCode-shaped log lines
  // and still returns a valid AgentRunResult.
  process.stdout.write(
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'I should write the movement module first.' },
          { type: 'text', text: 'Writing movement.js' },
          { type: 'tool_use', name: 'Write', input: { file_path: 'game/movement.js' } },
        ],
      },
    }) + '\n',
  )
  process.stdout.write(
    JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', is_error: true, content: 'ENOENT: no such file' }] },
    }) + '\n',
  )
  process.stdout.write(
    JSON.stringify({ type: 'result', is_error: false, result: 'done', session_id: 'agent-session-stream', usage: { input_tokens: 10, output_tokens: 5 } }) + '\n',
  )
  process.exit(0)
} else if (mode === 'write-in-scope-declare-run-command') {
  await writeUnder(process.env.FAKE_CLAUDE_WRITE_PATH ?? 'in-scope-file.txt', 'in scope content')
  const runLine = process.env.FAKE_CLAUDE_RUN_LINE ?? 'RUN: node test.mjs'
  process.stdout.write(
    JSON.stringify({ type: 'result', is_error: false, result: `Wrote the test.\n${runLine}` }),
  )
  process.exit(0)
} else if (mode === 'write-in-scope-multi') {
  // Writes MORE than one in-scope file: a support/non-test file whose name
  // sorts BEFORE the test file (via FAKE_CLAUDE_SUPPORT_PATH), plus the
  // actual test file (FAKE_CLAUDE_WRITE_PATH). Exercises T1.2 — the
  // filePath recorded must be the test file, not git's alphabetically-first
  // changed path.
  await writeUnder(process.env.FAKE_CLAUDE_SUPPORT_PATH ?? 'login-ui/index.html', '<!doctype html>')
  await writeUnder(process.env.FAKE_CLAUDE_WRITE_PATH ?? 'login-ui/nav.test.mjs', 'process.exit(0)\n')
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'wrote support + test file' }))
  process.exit(0)
}
