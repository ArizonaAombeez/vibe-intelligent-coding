// Turns a Coding run's raw CLI output into short, human-readable lines for
// display (CodingScreen's live-log panel and "Raw output" details).
//
// OpenCode's `--format json` (see vic-llm-opencode's OpenCodeAgentClient)
// streams one JSON object per line — tool calls, step markers, model text.
// Claude Code's `--output-format json` (see vic-llm-claude-code's
// ClaudeCodeAgentClient) instead buffers one JSON document across the whole
// run, so mid-run chunks here are arbitrary fragments of it, never a
// complete parseable line. Rather than special-case which backend produced
// a given log, this parses defensively line-by-line: a line that parses as
// JSON and matches a known OpenCode event shape becomes a summary line,
// anything else (plain text, a partial JSON fragment, a future/unknown
// event shape) passes through unchanged. Never throws, never drops input —
// worst case output equals input.

interface ToolUseState {
  status?: string
  input?: Record<string, unknown>
  error?: string
}

interface OpenCodePart {
  type?: string
  tool?: string
  text?: string
  state?: ToolUseState
}

interface OpenCodeEvent {
  type?: string
  part?: OpenCodePart
}

// Best-effort short label for a tool call: the specific thing it touched
// (file path, glob pattern, url), not its full JSON input — that's what
// makes this readable instead of just a shorter dump of the same noise.
function describeTool(tool: string, input: Record<string, unknown> | undefined): string {
  // OpenCode uses `filePath`; Claude Code's stream-json uses `file_path`.
  const filePath =
    typeof input?.filePath === 'string' ? input.filePath : typeof input?.file_path === 'string' ? input.file_path : undefined
  const shortPath = filePath ? filePath.split(/[\\/]/).pop() : undefined
  switch (tool) {
    case 'read':
      return `Read ${shortPath ?? filePath ?? ''}`.trim()
    case 'write':
      return `Wrote ${shortPath ?? filePath ?? ''}`.trim()
    case 'edit':
    case 'multiedit':
      return `Edited ${shortPath ?? filePath ?? ''}`.trim()
    case 'glob':
      return `Searched for ${typeof input?.pattern === 'string' ? input.pattern : 'files'}`
    case 'grep':
      return `Searched text for ${typeof input?.pattern === 'string' ? input.pattern : ''}`.trim()
    case 'bash':
      return `Ran: ${typeof input?.command === 'string' ? input.command : ''}`.trim()
    case 'webfetch':
      return `Fetched ${typeof input?.url === 'string' ? input.url : ''}`.trim()
    case 'todowrite':
      return 'Updated task list'
    case 'task':
      return `Delegated sub-task${typeof input?.description === 'string' ? `: ${input.description}` : ''}`
    default:
      return shortPath ? `${tool}: ${shortPath}` : tool
  }
}

// A file path a tool call touched, if it was a write/edit — used by the
// Coding screen to build a live "Files changed" list from the run log.
export function fileWrittenByToolInput(tool: string, input: Record<string, unknown> | undefined): string | undefined {
  if (tool !== 'write' && tool !== 'edit' && tool !== 'multiedit') return undefined
  const fp = typeof input?.filePath === 'string' ? input.filePath : typeof input?.file_path === 'string' ? input.file_path : undefined
  return fp ? fp.split(/[\\/]/).pop() : undefined
}

function formatLine(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed) return ''
  let event: OpenCodeEvent
  try {
    event = JSON.parse(trimmed)
  } catch {
    return null
  }
  const part = event.part
  if (!part || typeof event.type !== 'string') return null

  if (event.type === 'tool_use' && part.type === 'tool' && part.tool) {
    const state = part.state
    const label = describeTool(part.tool, state?.input)
    if (state?.status === 'error') return `✗ ${label}${state.error ? ` — ${state.error}` : ''}`
    return `• ${label}`
  }
  if (event.type === 'text' && part.type === 'text' && typeof part.text === 'string') {
    return part.text
  }
  // GLM (and other reasoning-capable models via OpenCode) can emit a
  // separate 'reasoning' part carrying the model's chain-of-thought text
  // ahead of its actual tool calls/output — shown with a distinguishing
  // prefix so it reads as "thinking" rather than the model's real reply.
  if (event.type === 'reasoning' && part.type === 'reasoning' && typeof part.text === 'string') {
    return `\u{1F4AD} ${part.text}`
  }
  // step_start/step_finish and anything else recognised-but-uninteresting —
  // deliberately omitted rather than shown as noise.
  if (event.type === 'step_start' || event.type === 'step_finish') return ''

  return null
}

// A structured digest of a coding run's log, for the Coding screen's
// right-hand live panel: the ordered list of files the agent
// wrote/edited (deduped, most-recent-last), any reasoning/"thinking" text
// it emitted, and any tool errors. Best-effort and defensive, exactly like
// formatCodingLog — a line that doesn't parse is simply ignored here.
export interface CodingLogDigest {
  filesChanged: string[]
  thoughts: string[]
  toolErrors: string[]
  toolActivity: string[]
}

export function digestCodingLog(raw: string): CodingLogDigest {
  const filesChanged: string[] = []
  const thoughts: string[] = []
  const toolErrors: string[] = []
  const toolActivity: string[] = []
  if (!raw) return { filesChanged, thoughts, toolErrors, toolActivity }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let event: OpenCodeEvent
    try {
      event = JSON.parse(trimmed)
    } catch {
      continue
    }
    const part = event.part
    if (!part) continue
    if (event.type === 'tool_use' && part.type === 'tool' && part.tool) {
      const state = part.state
      if (state?.status === 'error') {
        toolErrors.push(`${describeTool(part.tool, state?.input)}${state.error ? ` — ${state.error}` : ''}`)
      } else {
        toolActivity.push(describeTool(part.tool, state?.input))
        const written = fileWrittenByToolInput(part.tool, state?.input)
        if (written) {
          const existing = filesChanged.indexOf(written)
          if (existing !== -1) filesChanged.splice(existing, 1)
          filesChanged.push(written)
        }
      }
    } else if (event.type === 'reasoning' && part.type === 'reasoning' && typeof part.text === 'string' && part.text.trim()) {
      thoughts.push(part.text.trim())
    }
  }
  return { filesChanged, thoughts, toolErrors, toolActivity }
}

// Formats a full log for display. Unrecognised or unparseable lines (most
// importantly: a Claude Code run, or a partial/incomplete line still
// arriving live) fall back to their original raw text rather than being
// dropped, so this is always safe to apply.
export function formatCodingLog(raw: string): string {
  if (!raw) return raw
  const lines = raw.split('\n')
  const out: string[] = []
  for (const line of lines) {
    const formatted = formatLine(line)
    out.push(formatted === null ? line : formatted)
  }
  return out.filter((l, i) => l !== '' || i === out.length - 1).join('\n')
}
