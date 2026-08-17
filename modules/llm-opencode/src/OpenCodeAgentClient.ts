import spawn from 'cross-spawn'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AgentRunOptions, AgentRunResult } from 'vic-llm-claude-code'

// Same rationale as ClaudeCodeAgentClient's identical constant: without a
// ceiling, a hung opencode.exe (verified to happen with zero
// stdout/stderr/network activity — see runCli's stdio comment below) holds
// the project's run-lock open forever.
const CODING_RUN_TIMEOUT_MS = 15 * 60 * 1000

// GLM-native counterpart to vic-llm-claude-code's ClaudeCodeAgentClient —
// same runAgentTask(prompt, options) contract, so vic-coding's
// runCodingForStory can use either interchangeably (see vic-coding's
// CodingAgentClient interface). Where ClaudeCodeAgentClient spawns
// Anthropic's own `claude` CLI, this spawns the open-source OpenCode CLI
// (npm: opencode-ai) instead — a maintained, provider-agnostic agentic
// coding tool with real filesystem/tool access, installable via npm (no
// Python toolchain, unlike aider — see the git history of this module for
// why aider was tried first and abandoned: aider-chat's pinned
// numpy==1.24.3 has no prebuilt wheel for recent Python versions and
// repeatedly failed to build from source in this environment).
//
// Provider wiring uses the generic @ai-sdk/openai-compatible shape (rather
// than depending on OpenCode's exact internal id for z.ai, which isn't
// documented precisely) — any OpenAI-compatible endpoint, including z.ai's
// GLM Coding Plan, works through this same generic path.
//
// OpenCode's `run --format json` emits "raw JSON events" per its own docs,
// with no documented single-object success/failure schema (unlike
// ClaudeCodeAgentClient's ClaudeCodePrintResult) — rather than guess at an
// undocumented event-stream shape, this client treats the combined
// stdout+stderr purely as rawLog for the user to read. Success/failure of
// the actual file changes is still determined the same way the rest of the
// Coding pipeline already determines it downstream:
// gitStatusPorcelain/gitDiffText in gitDiff.ts see whatever OpenCode
// actually wrote to disk, independent of what its stdout says.

export class OpenCodeAgentError extends Error {
  constructor(
    message: string,
    public readonly exitCode?: number | null,
    public readonly rawLog?: string,
  ) {
    super(message)
    this.name = 'OpenCodeAgentError'
  }
}

// One VIC-managed provider id per run — arbitrary, only needs to be
// referenced consistently between the generated config and the --model
// flag below.
const PROVIDER_ID = 'vic-glm'

// OpenCode's `run` command takes the prompt only as a positional argv
// string — there is no --message-file/stdin equivalent. On Windows, an npm
// global install's `opencode` resolves to a .cmd shim, and cmd.exe's
// batch-parameter (`%*`) line reconstruction cannot represent an argv
// entry containing embedded newlines — the exact corruption
// ClaudeCodeAgentClient avoids via stdin. Since `run` has no
// prompt-from-file flag, this instead uses its --file attachment flag: the
// real (possibly multi-line) prompt is written to a temp file and
// attached, while the only positional argv text is this fixed, single-line,
// newline-free instruction — immune to the shim issue since it has nothing
// for cmd.exe's line tokenizer to corrupt. Verified against a real install:
// `opencode run [message] --file <path>` (positional message BEFORE
// --file) is the order that actually works — the reverse order
// (--file before the positional message) makes opencode misparse the
// positional text itself as a second --file target and fail immediately
// with "File not found: <message>".
const POSITIONAL_MESSAGE = 'Follow the attached instructions.'

export class OpenCodeAgentClient {
  async runAgentTask(prompt: string, options: AgentRunOptions): Promise<AgentRunResult> {
    const binary = options.binary ?? 'opencode'
    const binaryArgs = options.binaryArgs ?? []

    // Everything ephemeral for this run lives in one temp dir: the prompt
    // attachment file and a per-run opencode.json (avoids depending on a
    // shared global ~/.config/opencode/opencode.json that every concurrent
    // project/run would otherwise contend over). OPENCODE_CONFIG points
    // this specific invocation at it.
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'vic-opencode-'))
    const promptFile = path.join(tmpDir, `${randomUUID()}.txt`)
    const configFile = path.join(tmpDir, 'opencode.json')

    try {
      await writeFile(promptFile, prompt, 'utf-8')

      const env: NodeJS.ProcessEnv = { ...process.env }

      if (options.model) {
        // The API key is written directly into this config, NOT via
        // OpenCode's documented {env:VAR} substitution syntax — verified
        // against a real install that {env:...} silently fails to resolve
        // here (OpenCode sends the request with no Authorization header at
        // all, z.ai returns "Authentication parameter not received in
        // Header", and the run then hangs/retries rather than surfacing
        // that cleanly). Safe to write the real key to disk here because
        // this config file lives only in this run's own temp dir, created
        // fresh and deleted in the `finally` below — never a shared or
        // long-lived location.
        const config = {
          provider: {
            [PROVIDER_ID]: {
              npm: '@ai-sdk/openai-compatible',
              name: 'VIC GLM (z.ai)',
              options: {
                baseURL: options.baseUrl,
                apiKey: options.apiKey,
              },
              models: {
                [options.model]: { name: options.model },
              },
            },
          },
        }
        await writeFile(configFile, JSON.stringify(config, null, 2), 'utf-8')
        env.OPENCODE_CONFIG = configFile
      }

      const args = [
        ...binaryArgs,
        'run',
        '--dir',
        options.cwd,
        '--auto',
        '--format',
        'json',
      ]
      if (options.model) args.push('--model', `${PROVIDER_ID}/${options.model}`)
      // The only positional argv text — see POSITIONAL_MESSAGE's comment
      // for why the real prompt is attached via --file instead. Must come
      // BEFORE --file (verified against a real install — the reverse order
      // makes opencode misread this string as a second --file target).
      args.push(POSITIONAL_MESSAGE, '--file', promptFile)

      if (process.env.VIC_DEBUG_CLI) {
        console.error('[OpenCodeAgentClient] spawning', { binary, args, cwd: options.cwd })
      }

      const { stdout, stderr, exitCode } = await runCli(binary, args, options.cwd, env, options.onChunk, options.signal)
      const rawLog = stdout + (stderr ? `\n${stderr}` : '')

      if (exitCode !== 0) {
        throw new OpenCodeAgentError(
          `opencode CLI exited with code ${exitCode}: ${stderr || '(no stderr output)'}`,
          exitCode,
          rawLog,
        )
      }

      return { rawLog, exitCode }
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  }
}

function runCli(
  binary: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  onChunk?: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    // cross-spawn (not plain node:child_process) for the same reason as
    // ClaudeCodeAgentClient/gitDiff.ts: plain spawn with shell:false throws
    // ENOENT on a .cmd shim on Windows (npm global installs produce one for
    // opencode), and shell:true reintroduces an injection surface and its
    // own Windows argv-quoting corruption. args is passed as an array, not
    // a shell-parsed string, so each entry (including POSITIONAL_MESSAGE)
    // reaches the child as a single argv element via the OS
    // process-creation API directly — no cmd.exe line-tokenizer involved
    // for a plain, single-line, ASCII string like POSITIONAL_MESSAGE.
    // stdio[0] must be 'ignore', not the default 'pipe': an open, never-
    // written, never-closed stdin pipe makes opencode.exe block forever
    // before producing any output at all (verified directly — same spawn
    // with stdin piped vs ignored is the entire difference between a
    // ~20s run and an infinite hang with zero stdout/stderr/network
    // activity). This run is fully driven by --auto/--file/positional
    // message; nothing is ever written to the child's stdin.
    const child = spawn(binary, args, { shell: false, cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false

    // See CODING_RUN_TIMEOUT_MS above: this is the ceiling that prevents a
    // hang like the one documented in this function's stdio comment from
    // holding the caller's project run-lock open forever (see
    // runLogRegistry.ts's acquireProjectRunLock).
    const onAbort = (reason: string) => {
      if (settled) return
      child.kill()
      settled = true
      reject(new OpenCodeAgentError(reason, null, stdout + (stderr ? `\n${stderr}` : '')))
    }
    const timer = setTimeout(() => onAbort(`opencode CLI timed out after ${CODING_RUN_TIMEOUT_MS / 60000} minutes with no response`), CODING_RUN_TIMEOUT_MS)
    signal?.addEventListener('abort', () => onAbort('opencode CLI run was cancelled'))

    child.stdout?.on('data', (chunk) => {
      stdout += chunk
      onChunk?.(String(chunk))
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
      onChunk?.(String(chunk))
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(
        new OpenCodeAgentError(
          `Failed to launch "${binary}": ${err.message}. Is OpenCode installed (npm install -g opencode-ai) and on PATH?`,
        ),
      )
    })
    child.on('close', (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr, exitCode })
    })
  })
}
