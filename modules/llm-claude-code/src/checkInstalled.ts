import spawn from 'cross-spawn'

export interface ClaudeCodeInstallStatus {
  installed: boolean
  // Parsed from `claude --version` stdout, e.g. "2.1.224 (Claude Code)".
  // Undefined when not installed or the version string couldn't be read.
  version?: string
  // Present only when installed is false, so the UI has something concrete
  // to show ("command not found" vs. a non-zero exit vs. a timeout).
  error?: string
}

const VERSION_CHECK_TIMEOUT_MS = 5000

// Checks whether the Claude Code CLI is on PATH and runnable, using
// `--version` only. This is a local metadata query the CLI answers without
// contacting Anthropic or touching Pro/Max plan usage — unlike `chat()`
// below, calling this function is always free to call as often as the UI
// needs (e.g. every time the Settings screen is opened).
export function checkClaudeCodeInstalled(
  binary = 'claude',
): Promise<ClaudeCodeInstallStatus> {
  return new Promise((resolve) => {
    let settled = false
    const child = spawn(binary, ['--version'], { shell: false })

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      resolve({ installed: false, error: `Timed out waiting for "${binary} --version"` })
    }, VERSION_CHECK_TIMEOUT_MS)

    let stdout = ''
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ installed: false, error: err.message })
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) {
        resolve({ installed: false, error: `"${binary} --version" exited with code ${code}` })
        return
      }
      resolve({ installed: true, version: stdout.trim() || undefined })
    })
  })
}
