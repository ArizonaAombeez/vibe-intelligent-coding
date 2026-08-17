#!/usr/bin/env node
// Stand-in for the real `claude` CLI, driven entirely by env vars so tests
// don't depend on the actual CLI being installed. Mirrors just enough of
// `claude --print --output-format json`'s contract for ClaudeCodeCliClient
// to be tested against: reads the prompt from stdin (matching how the real
// client sends it — see runCli's comment on why argv can't carry a
// multi-line prompt through the Windows .cmd shim), and responds according
// to FAKE_CLAUDE_MODE.

const mode = process.env.FAKE_CLAUDE_MODE ?? 'ok'
const args = process.argv.slice(2)

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

const prompt = await readStdin()

if (mode === 'ok') {
  process.stdout.write(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: `echo: ${prompt}`,
      session_id: 'fake-session-123',
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 0,
      },
    }),
  )
  process.exit(0)
} else if (mode === 'no-usage') {
  process.stdout.write(
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'no usage here' }),
  )
  process.exit(0)
} else if (mode === 'error-result') {
  process.stdout.write(
    JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, result: null }),
  )
  process.exit(0)
} else if (mode === 'bad-json') {
  process.stdout.write('not json at all')
  process.exit(0)
} else if (mode === 'nonzero-exit') {
  process.stderr.write('simulated CLI failure')
  process.exit(1)
} else if (mode === 'echo-args') {
  process.stdout.write(
    JSON.stringify({ type: 'result', is_error: false, result: JSON.stringify([...args, prompt]) }),
  )
  process.exit(0)
}
