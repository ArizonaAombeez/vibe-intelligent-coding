export type LlmRole = 'system' | 'user' | 'assistant'

export interface LlmMessage {
  role: LlmRole
  content: string
}

export interface ChatOptions {
  temperature?: number
  maxTokens?: number
  // Overrides the client's configured model for this call only.
  model?: string
  // Overrides the client's configured effort level for this call only.
  effort?: string
}

// Mirrors the CLI's own --print --output-format json usage block, echoed
// back so the application layer can accumulate a running session total the
// same way it does for API-key-backed providers. Cache fields are kept
// separate from input/output since Claude Code's own usage-tracking UI
// reports them separately and cache reads are billed differently from a
// cold input token.
export interface ChatUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
}

export interface ChatResult {
  content: string
  usage?: ChatUsage
  // The CLI's own session id for this exchange, e.g. for future --resume
  // support. Optional because it's CLI-reported, same reasoning as
  // ChatUsage being optional on GlmClient.
  sessionId?: string
}

export interface ClaudeCodeChatClient {
  chat(messages: LlmMessage[], options?: ChatOptions): Promise<ChatResult>
}
