import spawn from 'cross-spawn'

export interface OpenCodeInstallStatus {
  installed: boolean
  // Parsed from `opencode --version` stdout. Undefined when not installed
  // or the version string couldn't be read.
  version?: string
  // Present only when installed is false, so the UI has something concrete
  // to show ("command not found" vs. a non-zero exit vs. a timeout).
  error?: string
}

// Mirrors vic-llm-claude-code's checkClaudeCodeInstalled exactly — same
// spawn/timeout/resolve pattern.
const VERSION_CHECK_TIMEOUT_MS = 5000

export function checkOpenCodeInstalled(binary = 'opencode'): Promise<OpenCodeInstallStatus> {
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
