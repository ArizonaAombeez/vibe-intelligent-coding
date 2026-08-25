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
  const filePath = typeof input?.filePath === 'string' ? input.filePath : undefined
  const shortPath = filePath ? filePath.split(/[\\/]/).pop() : undefined
  switch (tool) {
    case 'read':
      return `Read ${shortPath ?? filePath ?? ''}`.trim()
    case 'write':
      return `Wrote ${shortPath ?? filePath ?? ''}`.trim()
    case 'edit':
      return `Edited ${shortPath ?? filePath ?? ''}`.trim()
    case 'glob':
      return `Searched for ${typeof input?.pattern === 'string' ? input.pattern : 'files'}`
    case 'grep':
      return `Searched text for ${typeof input?.pattern === 'string' ? input.pattern : ''}`.trim()
    case 'bash':
      return `Ran: ${typeof input?.command === 'string' ? input.command : ''}`.trim()
    case 'webfetch':
      return `Fetched ${typeof input?.url === 'string' ? input.url : ''}`.trim()
    default:
      return shortPath ? `${tool}: ${shortPath}` : tool
  }
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
