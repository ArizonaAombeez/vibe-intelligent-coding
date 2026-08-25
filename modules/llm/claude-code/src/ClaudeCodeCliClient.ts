import spawn from 'cross-spawn'
import type {
  ChatOptions,
  ChatResult,
  ChatUsage,
  ClaudeCodeChatClient,
  LlmMessage,
} from './ClaudeCodeClient.js'

// Shape of `claude --print --output-format json`'s single result object.
// Only the fields this client reads are declared — the CLI's actual
// payload carries more (e.g. cost, duration) that callers don't need yet.
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

export interface ClaudeCodeCliClientOptions {
  // Path to the CLI binary if it's not on PATH under the default name.
  binary?: string
  // Fixed args inserted before the CLI's own flags, e.g. ['fixture.mjs']
  // when binary is 'node' so tests can spawn a stand-in script. Never used
  // in production — only a test injection seam.
  binaryArgs?: string[]
  model?: string
  effort?: string
}

export class ClaudeCodeCliError extends Error {
  constructor(
    message: string,
    public readonly exitCode?: number | null,
    public readonly stderr?: string,
  ) {
    super(message)
    this.name = 'ClaudeCodeCliError'
  }
}

// A single `-p` message turn has no prior conversation state in the CLI's
// own session store, so system/assistant history is folded into one prompt
// text block ahead of the final user turn — the CLI has no separate
// "messages array" input, only a single prompt string per invocation.
function buildPrompt(messages: LlmMessage[]): string {
  return messages
    .map((m) => (m.role === 'user' ? m.content : `[${m.role}]\n${m.content}`))
    .join('\n\n')
}

export class ClaudeCodeCliClient implements ClaudeCodeChatClient {
  private readonly binary: string
  private readonly binaryArgs: string[]
  private readonly model?: string
  private readonly effort?: string

  constructor(options: ClaudeCodeCliClientOptions = {}) {
    this.binary = options.binary ?? 'claude'
    this.binaryArgs = options.binaryArgs ?? []
    this.model = options.model
    this.effort = options.effort
  }

  async chat(messages: LlmMessage[], options: ChatOptions = {}): Promise<ChatResult> {
    const prompt = buildPrompt(messages)
    const args = [...this.binaryArgs, '--print', '--output-format', 'json']
    const model = options.model ?? this.model
    if (model) args.push('--model', model)
    const effort = options.effort ?? this.effort
    if (effort) args.push('--effort', effort)

    const { stdout, stderr, exitCode } = await runCli(this.binary, args, prompt)

    if (exitCode !== 0) {
      throw new ClaudeCodeCliError(
        `claude CLI exited with code ${exitCode}: ${stderr || '(no stderr output)'}`,
        exitCode,
        stderr,
      )
    }

    let parsed: ClaudeCodePrintResult
    try {
      parsed = JSON.parse(stdout)
    } catch {
      throw new ClaudeCodeCliError(
        `claude CLI did not return valid JSON: ${stdout.slice(0, 200)}`,
      )
    }

    if (parsed.is_error || typeof parsed.result !== 'string') {
      throw new ClaudeCodeCliError(
        `claude CLI reported an error: ${parsed.result ?? parsed.subtype ?? 'unknown error'}`,
      )
    }

    return {
      content: parsed.result,
      sessionId: parsed.session_id,
      usage: toChatUsage(parsed.usage),
    }
  }
}

function toChatUsage(usage: ClaudeCodePrintResult['usage']): ChatUsage | undefined {
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

function runCli(
  binary: string,
  args: string[],
  stdin: string,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    // The prompt is written to the child's stdin rather than appended to
    // args. On Windows, `claude` on PATH resolves to a `claude.cmd` shim
    // that forwards args via a batch-file `%*` expansion (see the shim's
    // contents in node_modules\@anthropic-ai\claude-code\... or npm's
    // generated wrapper) — `%*` reconstructs the command line from what
    // cmd.exe parsed, and cmd.exe's line-based tokenizer cannot represent an
    // argument containing embedded newlines, so any multi-line prompt
    // (buildPrompt joins messages with blank lines) silently arrives empty
    // or truncated no matter how carefully the outer spawn call quotes argv.
    // Piping the prompt as raw stdin bytes sidesteps cmd.exe parsing
    // entirely; the CLI's default --input-format text reads a full prompt
    // from stdin when none is given positionally.
    //
    // cross-spawn (not plain node:child_process) is still required here:
    // plain spawn with shell:false throws ENOENT on the .cmd shim itself
    // (see checkInstalled.ts, which hits the same constraint), and
    // shell:true reintroduces both an injection surface for prompt text
    // and its own Windows argv-quoting corruption for args containing
    // spaces (verified separately) — cross-spawn resolves .cmd/.bat
    // correctly while keeping args as a real argv array.
    if (process.env.VIC_DEBUG_CLI) {
      console.error('[ClaudeCodeCliClient] spawning', {
        binary,
        args,
        cwd: process.cwd(),
        PATH: process.env.PATH,
        PATHEXT: process.env.PATHEXT,
        stdinLength: stdin.length,
        node: process.version,
        platform: process.platform,
      })
    }

    const child = spawn(binary, args, { shell: false })
    let stdout = ''
    let stderr = ''

    if (process.env.VIC_DEBUG_CLI) {
      console.error('[ClaudeCodeCliClient] spawned', {
        pid: child.pid,
        spawnfile: (child as unknown as { spawnfile?: string }).spawnfile,
        spawnargs: (child as unknown as { spawnargs?: string[] }).spawnargs,
      })
    }

    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (err) => {
      if (process.env.VIC_DEBUG_CLI) {
        console.error('[ClaudeCodeCliClient] error event', err)
      }
      reject(
        new ClaudeCodeCliError(
          `Failed to launch "${binary}": ${err.message}. Is Claude Code installed and on PATH?`,
        ),
      )
    })
    child.on('close', (exitCode, signal) => {
      if (process.env.VIC_DEBUG_CLI) {
        console.error('[ClaudeCodeCliClient] close event', { exitCode, signal })
      }
      resolve({ stdout, stderr, exitCode })
    })
    child.stdin?.write(stdin)
    child.stdin?.end()
  })
}
