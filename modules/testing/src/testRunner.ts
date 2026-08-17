import spawn from 'cross-spawn'

// The mechanical test-execution subprocess runner (Area F). Deliberately
// NOT ClaudeCodeAgentClient — running `npm test`/`pytest`/etc. is not an
// LLM call and needs no agentic tool access, only cwd-scoping and a
// captured exit code + stdout/stderr; using the agentic client here would
// spend LLM tokens and CLI-permission machinery on a purely mechanical
// action, and would make "did the test suite pass" depend on an LLM's own
// summarization of output rather than a real, deterministic exit code.
// Structurally close to vic-coding's gitDiff.ts runGit helper (spawn,
// capture, resolve).

export interface RunTestCommandOptions {
  command: string
  args: string[]
  // MUST be the owning element's (or interface pair's) own scoped
  // subfolder absolute path — never the source tree root, never any path
  // outside it. This function does not itself re-validate cwd (that's the
  // caller's responsibility, same separation as runGit not validating its
  // own cwd argument); every call site in this module is required to go
  // through resolveExecutionScope (executionScopeGate.ts) first.
  cwd: string
  timeoutMs?: number
}

export interface RunTestCommandResult {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
}

const DEFAULT_TIMEOUT_MS = 120_000

// A hard timeout is required here (unlike runGit/runAgentTask, both
// naturally bounded) since an unbounded test run — e.g. an infinite loop
// in a bad generated test — must not hang the server indefinitely.
export function runTestCommand(options: RunTestCommandOptions): Promise<RunTestCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, { shell: false, cwd: options.cwd })
    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`Failed to run test command "${options.command}": ${err.message}`))
    })
    child.on('close', (exitCode) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, exitCode, timedOut })
    })
  })
}
