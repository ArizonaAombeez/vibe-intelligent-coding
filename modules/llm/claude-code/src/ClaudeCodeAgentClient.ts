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
  // Also GLM/OpenCode-only, same rationale as apiKey/baseUrl above — z.ai's
  // "thinking" on/off switch (see vic-llm-glm's settingsManifest.ts
  // THINKING_OPTIONS). Was previously resolved into the persona's
  // LlmCallOptions (resolvePersonaLlmOptions in the server) but silently
  // dropped before reaching this call — the Settings UI told the user
  // "Disabled (faster, no reasoning trace)" for the Dev persona while every
  // actual Coding run still ran with z.ai's default (thinking enabled),
  // since nothing threaded the value this far. 'enabled' | 'disabled' (a
  // plain string, not a union, to match every other provider-routing field
  // here and LlmCallOptions' own Record<string, string | undefined> shape).
  thinking?: string
  // GLM/OpenCode-only, same rationale as thinking above — z.ai's separate
  // reasoning_effort knob (see vic-llm-glm's settingsManifest.ts
  // REASONING_EFFORT_OPTIONS/GLM_MODEL_CAPABILITIES). The caller is
  // responsible for only setting this to a value the resolved model
  // actually documents support for (this interface has no model-capability
  // knowledge itself — see OpenCodeAgentClient.ts's comment on where that
  // gating happens).
  reasoningEffort?: string
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
  // T3.2: resume a prior CLI session (`claude --resume <id>`) so a later
  // iteration of the coding loop is the SAME agent continuing its own work
  // with full context, not a fresh agent re-reading a cold prompt. The id
  // comes from a previous AgentRunResult.sessionId. If the CLI rejects the
  // id (expired/unknown), the caller falls back to a full fresh prompt.
  // OpenCodeAgentClient ignores this, same as the other Claude-only fields.
  resumeSessionId?: string
}

// Provider-agnostic timing breakdown for one runAgentTask call — captured
// identically regardless of which concrete agent client (this one,
// OpenCodeAgentClient, or any future one) is running, since it's derived
// purely from process lifecycle events (spawn/first output/exit), not from
// any provider-specific event schema. This is what actually let a real
// multi-minute Coding run get diagnosed: OpenCode's own step_start/tool_use
// event stream showed a ~320s gap before the first tool call on some runs
// and ~1-5s on most others, with no correlation to prompt content — i.e.
// the delay is in how long the provider took to start responding at all,
// not in how much legitimate work the agent did once it started. Exposing
// this on every CodingRun (regardless of provider) is what makes that
// visible in the UI instead of requiring a manual rawLog dig each time.
export interface AgentRunTiming {
  // Wall-clock ms from the CLI subprocess being spawned to the first byte
  // of stdout/stderr being observed — the "how long before anything at all
  // happened" signal. Undefined if the process produced no output at all
  // before exiting/erroring (nothing to time against).
  msToFirstOutput?: number
  // Wall-clock ms from spawn to the process actually exiting — the CLI's
  // own total duration, independent of any local sync/scaffold overhead
  // the caller (runCodingForElement) adds around it.
  msTotal: number
}

// Which concrete agent client actually ran — a plain string id, not a
// closed union, so a new provider package can identify itself without
// this shared module needing to know about it in advance (mirrors how
// AgentRunOptions.apiKey/baseUrl are already provider-agnostic passthrough
// fields). Combined with AgentRunOptions.model (already threaded through
// from persona settings), this is what lets a CodingRun record "which
// provider and model actually ran," not just "some agent ran" — needed to
// meaningfully compare providers (e.g. GLM vs Claude) after the fact
// instead of only in the moment a run happens to be watched live.
export type AgentProviderId = 'claude-code' | 'opencode'

export interface AgentRunResult {
  rawLog: string
  exitCode: number | null
  sessionId?: string
  usage?: AgentChatUsage
  providerId: AgentProviderId
  timing: AgentRunTiming
}

export class ClaudeCodeAgentError extends Error {
  constructor(
    message: string,
    public readonly exitCode?: number | null,
    public readonly rawLog?: string,
    // Present whenever the failure happened after the subprocess was
    // spawned (i.e. everything except "failed to launch the binary at
    // all") — lets runCodingForElement's catch surface timing on a
    // cli-error CodingRun the same way a success one gets it, since a
    // long-stall-then-timeout IS exactly the failure mode this timing
    // exists to diagnose.
    public readonly timing?: AgentRunTiming,
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

// Translates one Claude Code `--output-format stream-json` event object into
// the SAME `{ type, part: { type, tool, text, state } }` line shape that
// OpenCode's `--format json` already emits — so formatCodingLog (in the UI)
// and formatCodingLog's server-side twin need only one parser for both
// backends. Returns null for events that carry nothing worth showing live
// (system/init frames, empty deltas). The mapped object is what gets
// re-serialised (one per line) into the live-run log the Coding screen
// polls; without this, a Claude Coding run showed *nothing* until the very
// end, because `--output-format json` buffers one document for the whole run.
function claudeStreamEventToLogLine(evt: unknown): string | null {
  if (!evt || typeof evt !== 'object') return null
  const e = evt as Record<string, any>

  // assistant/user message frames — pull out text + tool_use blocks.
  if (e.type === 'assistant' && e.message?.content) {
    const blocks: any[] = Array.isArray(e.message.content) ? e.message.content : []
    const out: string[] = []
    for (const b of blocks) {
      if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        out.push(JSON.stringify({ type: 'text', part: { type: 'text', text: b.text } }))
      } else if (b?.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) {
        out.push(JSON.stringify({ type: 'reasoning', part: { type: 'reasoning', text: b.thinking } }))
      } else if (b?.type === 'tool_use' && typeof b.name === 'string') {
        out.push(
          JSON.stringify({
            type: 'tool_use',
            part: { type: 'tool', tool: b.name.toLowerCase(), state: { status: 'running', input: b.input ?? {} } },
          }),
        )
      }
    }
    return out.length > 0 ? out.join('\n') : null
  }

  // tool results come back on a user frame — surface an error if it failed.
  if (e.type === 'user' && e.message?.content) {
    const blocks: any[] = Array.isArray(e.message.content) ? e.message.content : []
    const out: string[] = []
    for (const b of blocks) {
      if (b?.type === 'tool_result' && b.is_error) {
        const text = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((c: any) => c?.text).join(' ') : ''
        out.push(JSON.stringify({ type: 'tool_use', part: { type: 'tool', tool: 'tool', state: { status: 'error', error: text.slice(0, 300) } } }))
      }
    }
    return out.length > 0 ? out.join('\n') : null
  }

  return null
}

export class ClaudeCodeAgentClient {
  async runAgentTask(prompt: string, options: AgentRunOptions): Promise<AgentRunResult> {
    const binary = options.binary ?? 'claude'
    const binaryArgs = options.binaryArgs ?? []
    const args = [
      ...binaryArgs,
      '--print',
      // stream-json (not plain json) so the caller's onChunk sees tool
      // calls / reasoning / text as they happen — a multi-minute Coding run
      // otherwise looks completely silent in the live-run panel until it
      // exits. --verbose is required by the CLI when combining --print with
      // --output-format stream-json.
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      options.permissionMode ?? 'acceptEdits',
    ]
    if (options.model) args.push('--model', options.model)
    if (options.effort) args.push('--effort', options.effort)
    // T3.2: continue a prior session rather than starting cold.
    if (options.resumeSessionId) args.push('--resume', options.resumeSessionId)

    // Accumulates the terminal `type:"result"` frame from the stream so the
    // rest of this method keeps working exactly as it did with plain json.
    let resultFrame: ClaudeCodePrintResult | undefined
    // Re-serialised normalised event lines — this is what becomes rawLog,
    // matching the OpenCode client's newline-delimited-JSON rawLog shape so
    // formatCodingLog handles both identically.
    const normalisedLines: string[] = []

    let carry = ''
    const onStreamChunk = (chunk: string) => {
      carry += chunk
      const lines = carry.split('\n')
      carry = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let evt: any
        try {
          evt = JSON.parse(trimmed)
        } catch {
          continue
        }
        if (evt?.type === 'result') {
          resultFrame = evt
          continue
        }
        const mapped = claudeStreamEventToLogLine(evt)
        if (mapped) {
          normalisedLines.push(mapped)
          options.onChunk?.(mapped + '\n')
        }
      }
    }

    const { stdout, stderr, exitCode, timing } = await runCli(binary, args, prompt, options.cwd, onStreamChunk, options.signal)
    // Flush any trailing partial line.
    if (carry.trim()) {
      try {
        const evt = JSON.parse(carry.trim())
        if (evt?.type === 'result') resultFrame = evt
      } catch {
        /* ignore */
      }
    }
    const rawLog = normalisedLines.join('\n') + (stderr ? `\n${stderr}` : '') || stdout

    if (exitCode !== 0) {
      throw new ClaudeCodeAgentError(
        `claude CLI exited with code ${exitCode}: ${stderr || '(no stderr output)'}`,
        exitCode,
        rawLog,
        timing,
      )
    }

    if (!resultFrame) {
      throw new ClaudeCodeAgentError(
        `claude CLI stream ended without a result frame: ${stdout.slice(0, 200)}`,
        exitCode,
        rawLog,
        timing,
      )
    }

    if (resultFrame.is_error) {
      throw new ClaudeCodeAgentError(
        `claude CLI reported an error: ${resultFrame.result ?? resultFrame.subtype ?? 'unknown error'}`,
        exitCode,
        rawLog,
        timing,
      )
    }

    return {
      rawLog,
      exitCode,
      sessionId: resultFrame.session_id,
      usage: toAgentUsage(resultFrame.usage),
      providerId: 'claude-code',
      timing,
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
): Promise<{ stdout: string; stderr: string; exitCode: number | null; timing: AgentRunTiming }> {
  return new Promise((resolve, reject) => {
    // Wall-clock spawn time — the baseline every other timestamp in
    // AgentRunTiming is measured from. Set right before spawn() below, not
    // at runCli's own entry, so it excludes whatever (negligible) time the
    // Promise executor itself took to start.
    const spawnedAt = Date.now()
    let firstOutputAt: number | undefined
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
      reject(
        new ClaudeCodeAgentError(reason, null, stdout + (stderr ? `\n${stderr}` : ''), {
          msToFirstOutput: firstOutputAt !== undefined ? firstOutputAt - spawnedAt : undefined,
          msTotal: Date.now() - spawnedAt,
        }),
      )
    }
    const timer = setTimeout(() => onAbort(`claude CLI timed out after ${CODING_RUN_TIMEOUT_MS / 60000} minutes with no response`), CODING_RUN_TIMEOUT_MS)
    signal?.addEventListener('abort', () => onAbort('claude CLI run was cancelled'))

    child.stdout?.on('data', (chunk) => {
      firstOutputAt ??= Date.now()
      stdout += chunk
      onChunk?.(String(chunk))
    })
    child.stderr?.on('data', (chunk) => {
      firstOutputAt ??= Date.now()
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
          undefined,
          undefined,
          { msToFirstOutput: undefined, msTotal: Date.now() - spawnedAt },
        ),
      )
    })
    child.on('close', (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        stdout,
        stderr,
        exitCode,
        timing: {
          msToFirstOutput: firstOutputAt !== undefined ? firstOutputAt - spawnedAt : undefined,
          msTotal: Date.now() - spawnedAt,
        },
      })
    })
    child.stdin?.write(stdin)
    child.stdin?.end()
  })
}
