import spawn from 'cross-spawn'

// Hard ceiling on one Coding-stage CLI invocation — a run that hangs (dead
// network, stalled provider) would otherwise hold the project's run-lock
// open forever, permanently disabling the Coding screen's buttons with no
// visible error. 15 minutes comfortably covers a real multi-file Coding run
// (which typically finishes in well under a minute) while still bounding
// the wait for a genuinely stuck one.
const CODING_RUN_TIMEOUT_MS = 15 * 60 * 1000

// Second Claude Code CLI invocation mode, for the Coding stage (Area D) —
// distinct from ClaudeCodeCliClient's --print chat-completion wrapper
// (used for persona chat turns via ClaudeCodeChatClient/LlmClient). This
// client runs the CLI with real filesystem tool access scoped to a working
// directory (cwd), so it can actually create/modify files, not just return
// text. Deliberately does not implement ClaudeCodeChatClient/LlmClient —
// this is a different capability (an agentic run with filesystem
// side-effects) and isn't registered as an installable LLM plugin; it's
// constructed directly by the Coding module's server-route glue.

interface ClaudeCodePrintResult {
  type: string
  subtype?: string
  is_error?: boolean
  result?: string
  session_id?: string
  usage?: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
}

export interface AgentChatUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
}

export interface AgentRunOptions {
  // Working directory the CLI is spawned in — the project's generated
  // source tree root. The CLI's own filesystem tool access defaults to
  // this directory and its subtree, which is the first layer of the
  // Coding-stage write-scope gate (see vic-coding's scopeGate.ts for the
  // real enforcement, applied after this call returns).
  cwd: string
  permissionMode?: string
  model?: string
  effort?: string
  binary?: string
  // Test injection seam, mirrors ClaudeCodeCliClientOptions.binaryArgs.
  binaryArgs?: string[]
  // Provider-routing fields, ignored by ClaudeCodeAgentClient (which only
  // ever talks to Anthropic's own API via the CLI's own auth) but read by
  // vic-llm-opencode's OpenCodeAgentClient to point the opencode CLI at a
  // generic OpenAI-compatible endpoint (e.g. z.ai's GLM Coding Plan)
  // instead of OpenAI's own API. Declared here rather than in a third copy
  // of this interface so both agent clients share one
  // AgentRunOptions/AgentRunResult shape — see vic-coding's
  // CodingAgentClient.
  apiKey?: string
  baseUrl?: string
  // Called with each raw stdout/stderr chunk as the CLI produces it, in
  // addition to (not instead of) the final buffered rawLog on
  // AgentRunResult — lets a caller (the server's /run-coding route) surface
  // live progress to a polling client while a run is still in flight,
  // rather than the UI seeing nothing until the whole subprocess exits.
  // Optional and purely additive: omitting it changes no existing
  // behavior.
  onChunk?: (chunk: string) => void
  // Lets a caller kill the child process mid-run — either the server's own
  // idle timeout (see CODING_RUN_TIMEOUT_MS below) or a user-triggered
  // Cancel from the Coding screen (see runLogRegistry's cancelProjectRun).
  // Aborting rejects with ClaudeCodeAgentError rather than resolving, so
  // runCodingForElement's existing catch already turns it into a
  // 'cli-error' CodingRun with no changes needed there.
  signal?: AbortSignal
}

export interface AgentRunResult {
  rawLog: string
  exitCode: number | null
  sessionId?: string
  usage?: AgentChatUsage
}

export class ClaudeCodeAgentError extends Error {
  constructor(
    message: string,
    public readonly exitCode?: number | null,
    public readonly rawLog?: string,
  ) {
    super(message)
    this.name = 'ClaudeCodeAgentError'
  }
}

function toAgentUsage(usage: ClaudeCodePrintResult['usage']): AgentChatUsage | undefined {
  if (!usage) return undefined
  const promptTokens = usage.input_tokens ?? 0
  const completionTokens = usage.output_tokens ?? 0
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    cacheReadTokens: usage.cache_read_input_tokens,
    cacheCreationTokens: usage.cache_creation_input_tokens,
  }
}

export class ClaudeCodeAgentClient {
  async runAgentTask(prompt: string, options: AgentRunOptions): Promise<AgentRunResult> {
    const binary = options.binary ?? 'claude'
    const binaryArgs = options.binaryArgs ?? []
    const args = [
      ...binaryArgs,
      '--print',
      '--output-format',
      'json',
      '--permission-mode',
      options.permissionMode ?? 'acceptEdits',
    ]
    if (options.model) args.push('--model', options.model)
    if (options.effort) args.push('--effort', options.effort)

    const { stdout, stderr, exitCode } = await runCli(binary, args, prompt, options.cwd, options.onChunk, options.signal)
    const rawLog = stdout + (stderr ? `\n${stderr}` : '')

    if (exitCode !== 0) {
      throw new ClaudeCodeAgentError(
        `claude CLI exited with code ${exitCode}: ${stderr || '(no stderr output)'}`,
        exitCode,
        rawLog,
      )
    }

    let parsed: ClaudeCodePrintResult
    try {
      parsed = JSON.parse(stdout)
    } catch {
      throw new ClaudeCodeAgentError(`claude CLI did not return valid JSON: ${stdout.slice(0, 200)}`, exitCode, rawLog)
    }

    if (parsed.is_error) {
      throw new ClaudeCodeAgentError(
        `claude CLI reported an error: ${parsed.result ?? parsed.subtype ?? 'unknown error'}`,
        exitCode,
        rawLog,
      )
    }

    return {
      rawLog,
      exitCode,
      sessionId: parsed.session_id,
      usage: toAgentUsage(parsed.usage),
    }
  }
}

// Same cross-spawn/stdin-not-argv plumbing as ClaudeCodeCliClient.ts's
// runCli, duplicated rather than imported since that function is
// unexported/private there and this caller passes an extra option (cwd)
// that the chat client never sets.
function runCli(
  binary: string,
  args: string[],
  stdin: string,
  cwd: string,
  onChunk?: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    // The prompt is written to the child's stdin rather than appended to
    // args. On Windows, `claude` on PATH resolves to a `claude.cmd` shim
    // that forwards args via a batch-file `%*` expansion — `%*`
    // reconstructs the command line from what cmd.exe parsed, and cmd.exe's
    // line-based tokenizer cannot represent an argument containing embedded
    // newlines, so any multi-line prompt silently arrives empty or
    // truncated no matter how carefully the outer spawn call quotes argv.
    // Piping the prompt as raw stdin bytes sidesteps cmd.exe parsing
    // entirely; the CLI's default --input-format text reads a full prompt
    // from stdin when none is given positionally. See ClaudeCodeCliClient.ts
    // for the full original rationale (identical here).
    //
    // cross-spawn (not plain node:child_process) is required for the same
    // reason as ClaudeCodeCliClient.ts: plain spawn with shell:false throws
    // ENOENT on the .cmd shim, and shell:true reintroduces both an
    // injection surface and its own Windows argv-quoting corruption.
    if (process.env.VIC_DEBUG_CLI) {
      console.error('[ClaudeCodeAgentClient] spawning', { binary, args, cwd, stdinLength: stdin.length })
    }

    const child = spawn(binary, args, { shell: false, cwd })
    let stdout = ''
    let stderr = ''
    let settled = false

    // Belt-and-braces against the exact hang this guards: a CLI subprocess
    // that never emits a 'close' event (network stall, hung provider, etc.)
    // — see OpenCodeAgentClient's identical comment for a verified instance
    // of this happening with zero stdout/stderr/network activity. Without
    // this, the child holds the caller's project run-lock open forever (see
    // runLogRegistry.ts's acquireProjectRunLock) since the route's own
    // `finally` never runs.
    const onAbort = (reason: string) => {
      if (settled) return
      child.kill()
      settled = true
      reject(new ClaudeCodeAgentError(reason, null, stdout + (stderr ? `\n${stderr}` : '')))
    }
    const timer = setTimeout(() => onAbort(`claude CLI timed out after ${CODING_RUN_TIMEOUT_MS / 60000} minutes with no response`), CODING_RUN_TIMEOUT_MS)
    signal?.addEventListener('abort', () => onAbort('claude CLI run was cancelled'))

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
        new ClaudeCodeAgentError(
          `Failed to launch "${binary}": ${err.message}. Is Claude Code installed and on PATH?`,
        ),
      )
    })
    child.on('close', (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr, exitCode })
    })
    child.stdin?.write(stdin)
    child.stdin?.end()
  })
}
