#!/usr/bin/env node
// Stand-in for the real `opencode` CLI, driven by env vars so tests don't
// depend on the real CLI or a real LLM call. Reads OPENCODE_CONFIG (the
// per-run temp opencode.json OpenCodeAgentClient generates) and echoes its
// contents back on stdout as JSON, so a test can assert on exactly what
// config was written — e.g. that the vic-glm provider's options.body
// carries tool_stream:false — without needing a real opencode install.

import { readFile } from 'node:fs/promises'

const mode = process.env.FAKE_OPENCODE_MODE ?? 'echo-config'

if (mode === 'echo-config') {
  const configPath = process.env.OPENCODE_CONFIG
  const configText = configPath ? await readFile(configPath, 'utf8') : null
  process.stdout.write(configText ?? '{}')
  process.exit(0)
} else if (mode === 'nonzero-exit') {
  process.stderr.write('simulated opencode CLI failure')
  process.exit(1)
}
